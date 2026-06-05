/**
 * Locavik — Firebase Cloud Functions v2
 * Intégration Bridge API (agrégateur bancaire DSP2)
 */

'use strict';

const { onCall, onRequest, HttpsError } = require('firebase-functions/v2/https');
const { onSchedule }                    = require('firebase-functions/v2/scheduler');
const { logger }                        = require('firebase-functions');
const admin                             = require('firebase-admin');
const axios                             = require('axios');

admin.initializeApp();
const db = admin.firestore();

const REGION         = 'europe-west1';
const BRIDGE_BASE    = 'https://api.bridgeapi.io';
const BRIDGE_CONNECT = 'https://connect.bridgeapi.io';

const cfg = () => ({
  client_id:     process.env.BRIDGE_CLIENT_ID,
  client_secret: process.env.BRIDGE_CLIENT_SECRET,
  redirect_uri:  process.env.BRIDGE_REDIRECT_URI,
});

// ── Helpers ────────────────────────────────────────────────────────────────

function bridgeHeaders(token) {
  return {
    Authorization:    `Bearer ${token}`,
    'Bridge-Version': '2021-06-01',
    'Content-Type':   'application/json',
  };
}

function normalize(str) {
  return (str || '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function matchScore(label, first, last, rent, charges, amount) {
  const normLabel = normalize(label);
  const nameTokens = [...normalize(first).split(' '), ...normalize(last).split(' ')].filter(t => t.length > 1);
  const labelTokens = normLabel.split(' ');
  let score = 0;

  const nameMatches = nameTokens.filter(tok => labelTokens.some(lt => lt.includes(tok) || tok.includes(lt))).length;
  score += nameTokens.length > 0 ? Math.round((nameMatches / nameTokens.length) * 50) : 0;

  const total = (rent || 0) + (charges || 0);
  if (total > 0 && amount > 0) {
    const diff = Math.abs(amount - total);
    if (diff === 0)      score += 40;
    else if (diff <= 5)  score += 35;
    else if (diff <= 10) score += 25;
    else if (diff <= 30) score += 10;
  }

  if (/loyer|rent|quittance|loc/.test(normLabel)) score += 10;
  return Math.min(score, 100);
}

async function getValidToken(userId) {
  const doc = await db.collection('bridge_tokens').doc(userId).get();
  if (!doc.exists) return null;
  const data = doc.data();
  const expiresAt = data.expires_at?.toDate?.() || new Date(data.expires_at);
  if (expiresAt - Date.now() < 24 * 3600 * 1000) return refreshToken(userId, data);
  return data.access_token;
}

async function refreshToken(userId, tokenData) {
  const { client_id, client_secret } = cfg();
  try {
    const res = await axios.post(`${BRIDGE_BASE}/v2/authenticate/token`, {
      grant_type:    'refresh_token',
      client_id, client_secret,
      refresh_token: tokenData.refresh_token,
    }, { headers: { 'Bridge-Version': '2021-06-01', 'Content-Type': 'application/json' } });

    const expiresAt = new Date(Date.now() + (res.data.expires_in || 3600) * 1000);
    await db.collection('bridge_tokens').doc(userId).update({
      access_token:  res.data.access_token,
      refresh_token: res.data.refresh_token || tokenData.refresh_token,
      expires_at:    admin.firestore.Timestamp.fromDate(expiresAt),
    });
    return res.data.access_token;
  } catch (e) {
    logger.error('refreshToken error:', e.message);
    return null;
  }
}

// ── FONCTION 1 — getBridgeAuthUrl ──────────────────────────────────────────

exports.getBridgeAuthUrl = onCall({ region: REGION }, async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Authentification requise.');
  const { client_id, redirect_uri } = cfg();
  if (!client_id) throw new HttpsError('failed-precondition', 'Bridge non configuré.');

  const params = new URLSearchParams({
    client_id, redirect_uri,
    response_type: 'code',
    state: request.auth.uid,
  });
  return { url: `${BRIDGE_CONNECT}/v2/authorize?${params}` };
});

// ── FONCTION 2 — exchangeBridgeToken ──────────────────────────────────────

exports.exchangeBridgeToken = onRequest({ region: REGION }, async (req, res) => {
  res.set('Access-Control-Allow-Origin', 'https://locavik.com');
  const code = req.query.code || req.body?.code;
  const uid  = req.query.state || req.body?.state;
  if (!code || !uid) return res.status(400).json({ error: 'Paramètres manquants.' });

  const { client_id, client_secret, redirect_uri } = cfg();
  try {
    const tokenRes = await axios.post(`${BRIDGE_BASE}/v2/authenticate/token`, {
      grant_type: 'authorization_code',
      client_id, client_secret, redirect_uri, code,
    }, { headers: { 'Bridge-Version': '2021-06-01', 'Content-Type': 'application/json' } });

    const td = tokenRes.data;
    const expiresAt = new Date(Date.now() + (td.expires_in || 3600) * 1000);

    let bankName = 'Banque', ibanLast4 = '????';
    try {
      const accRes  = await axios.get(`${BRIDGE_BASE}/v2/accounts`, { headers: bridgeHeaders(td.access_token) });
      const accounts = accRes.data?.resources || accRes.data || [];
      if (accounts.length > 0) {
        bankName  = accounts[0].bank?.name || accounts[0].bank_name || bankName;
        ibanLast4 = (accounts[0].iban || '').slice(-4) || ibanLast4;
      }
    } catch (_) {}

    await db.collection('bridge_tokens').doc(uid).set({
      access_token:     td.access_token,
      refresh_token:    td.refresh_token || null,
      expires_at:       admin.firestore.Timestamp.fromDate(expiresAt),
      connected_at:     admin.firestore.FieldValue.serverTimestamp(),
      bridge_user_uuid: td.user?.uuid || null,
      banque_nom:       bankName,
      iban_partiel:     ibanLast4,
      user_id:          uid,
    });

    return res.redirect('https://locavik.com/dashboard.html#bridge-success');
  } catch (e) {
    logger.error('exchangeBridgeToken:', e.response?.data || e.message);
    return res.redirect('https://locavik.com/dashboard.html#bridge-error');
  }
});

// ── FONCTION 3 — syncTransactions (logique partagée) ───────────────────────

async function runSync(userId = null) {
  let query = db.collection('bridge_tokens');
  if (userId) query = query.where('user_id', '==', userId);
  const snap = await query.get();
  if (snap.empty) return { synced: 0 };

  let total = 0;
  for (const tokenDoc of snap.docs) {
    const uid   = tokenDoc.id;
    const token = await getValidToken(uid);
    if (!token) continue;

    const userDoc = await db.collection('users').doc(uid).get();
    if (!userDoc.exists) continue;
    const tenants = (userDoc.data().tenants || []).filter(t => t.active);

    const since = new Date(); since.setDate(since.getDate() - 35);
    let transactions = [];
    try {
      const res  = await axios.get(`${BRIDGE_BASE}/v2/transactions`, {
        headers: bridgeHeaders(token),
        params:  { since: since.toISOString().split('T')[0], limit: 200 },
      });
      transactions = res.data?.resources || res.data || [];
    } catch (e) { logger.error(`transactions ${uid}:`, e.message); continue; }

    for (const tx of transactions.filter(t => t.amount > 0)) {
      const existing = await db.collection('transactions_bancaires')
        .where('bridge_transaction_id', '==', String(tx.id))
        .where('locavik_uid', '==', uid).limit(1).get();
      if (!existing.empty && existing.docs[0].data().traite) continue;

      let best = 0, bestTenant = null;
      for (const t of tenants) {
        const s = matchScore(tx.label || tx.description || '', t.first || '', t.last || '', t.rent, t.charges, tx.amount);
        if (s > best) { best = s; bestTenant = t; }
      }

      const txDate  = new Date(tx.date || tx.transaction_date);
      const txMonth = txDate.getMonth() + 1;
      const txYear  = txDate.getFullYear();
      let statut = 'non_reconnu', matchId = null;

      if (best >= 80 && bestTenant) {
        statut = 'auto_valide'; matchId = bestTenant.id;
        if (bestTenant.auto_validation !== false) {
          const receipts = userDoc.data().receipts || [];
          if (!receipts.some(r => r.tenantId === bestTenant.id && r.month === txMonth && r.year === txYear && r.status === 'received')) {
            await db.collection('users').doc(uid).update({
              receipts: admin.firestore.FieldValue.arrayUnion({
                id: `r${Date.now()}${Math.random().toString(36).slice(2,5)}`,
                tenantId: bestTenant.id, month: txMonth, year: txYear,
                status: 'received', source: 'bridge_auto', amount: tx.amount,
                createdAt: new Date().toISOString(),
              }),
            });
            await db.collection('notifications').add({
              uid, type: 'loyer_auto_valide', tenantId: bestTenant.id,
              tenantName: `${bestTenant.first||''} ${bestTenant.last||''}`.trim(),
              montant: tx.amount, month: txMonth, year: txYear,
              lu: false, createdAt: admin.firestore.FieldValue.serverTimestamp(),
            });
          }
        }
      } else if (best >= 50 && bestTenant) {
        statut = 'a_confirmer'; matchId = bestTenant.id;
        await db.collection('notifications').add({
          uid, type: 'loyer_a_confirmer', tenantId: bestTenant.id,
          tenantName: `${bestTenant.first||''} ${bestTenant.last||''}`.trim(),
          montant: tx.amount, libelle: tx.label || '', score: best,
          month: txMonth, year: txYear, bridge_tx_id: String(tx.id),
          lu: false, createdAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      }

      const ref = existing.empty ? db.collection('transactions_bancaires').doc() : existing.docs[0].ref;
      await ref.set({
        bridge_transaction_id: String(tx.id), locavik_uid: uid,
        date: admin.firestore.Timestamp.fromDate(txDate),
        montant: tx.amount, libelle: tx.label || tx.description || '',
        locataire_id_match: matchId, score_matching: best,
        statut, traite: statut === 'auto_valide',
        synced_at: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
      total++;
    }

    await db.collection('bridge_tokens').doc(uid).update({
      last_sync: admin.firestore.FieldValue.serverTimestamp(),
    });
  }
  return { synced: total };
}

exports.syncTransactions = onSchedule({ schedule: 'every 6 hours', region: REGION }, async () => {
  logger.info('Sync Bridge planifiée — démarrage');
  const r = await runSync();
  logger.info(`Sync terminée — ${r.synced} transactions`);
});

exports.syncTransactionsManual = onCall({ region: REGION }, async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Authentification requise.');
  return runSync(request.auth.uid);
});

// ── FONCTION 4 — refreshBridgeToken ───────────────────────────────────────

exports.refreshBridgeToken = onCall({ region: REGION }, async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Authentification requise.');
  const doc = await db.collection('bridge_tokens').doc(request.auth.uid).get();
  if (!doc.exists) throw new HttpsError('not-found', 'Aucune connexion Bridge.');
  const token = await refreshToken(request.auth.uid, doc.data());
  if (!token) throw new HttpsError('internal', 'Impossible de rafraîchir le token.');
  return { success: true };
});

// ── FONCTION 5 — disconnectBridge ─────────────────────────────────────────

exports.disconnectBridge = onCall({ region: REGION }, async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Authentification requise.');
  const uid = request.auth.uid;
  const doc = await db.collection('bridge_tokens').doc(uid).get();
  if (doc.exists) {
    const { access_token } = doc.data();
    const { client_id, client_secret } = cfg();
    try {
      await axios.delete(`${BRIDGE_BASE}/v2/authenticate/token`, {
        headers: bridgeHeaders(access_token),
        data: { client_id, client_secret },
      });
    } catch (_) {}
    await db.collection('bridge_tokens').doc(uid).delete();
  }
  return { success: true };
});

// ── FONCTION 6 — getBridgeStatus ──────────────────────────────────────────

exports.getBridgeStatus = onCall({ region: REGION }, async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Authentification requise.');
  const uid = request.auth.uid;
  const doc = await db.collection('bridge_tokens').doc(uid).get();
  if (!doc.exists) return { connected: false };
  const d = doc.data();

  const monthStart = new Date(); monthStart.setDate(1); monthStart.setHours(0,0,0,0);
  const txSnap = await db.collection('transactions_bancaires')
    .where('locavik_uid', '==', uid)
    .where('date', '>=', admin.firestore.Timestamp.fromDate(monthStart)).get();

  return {
    connected:    true,
    banque_nom:   d.banque_nom   || 'Banque',
    iban_partiel: d.iban_partiel || '????',
    last_sync:    d.last_sync ? d.last_sync.toDate().toISOString() : null,
    tx_ce_mois:  txSnap.size,
    tx_matches:  txSnap.docs.filter(d => d.data().statut === 'auto_valide').length,
  };
});

// ── FONCTION 7 — confirmTransaction ───────────────────────────────────────

exports.confirmTransaction = onCall({ region: REGION }, async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Authentification requise.');
  const { bridge_tx_id, tenant_id, ignore } = request.data;
  const uid = request.auth.uid;

  const txSnap = await db.collection('transactions_bancaires')
    .where('bridge_transaction_id', '==', bridge_tx_id)
    .where('locavik_uid', '==', uid).limit(1).get();
  if (txSnap.empty) throw new HttpsError('not-found', 'Transaction introuvable.');

  const txRef  = txSnap.docs[0].ref;
  const txData = txSnap.docs[0].data();

  if (ignore) { await txRef.update({ statut: 'ignore', traite: true }); return { success: true }; }
  if (!tenant_id) throw new HttpsError('invalid-argument', 'tenant_id requis.');

  const userDoc = await db.collection('users').doc(uid).get();
  const tenant  = (userDoc.data()?.tenants || []).find(t => t.id === tenant_id);
  if (!tenant) throw new HttpsError('not-found', 'Locataire introuvable.');

  const txDate  = txData.date.toDate();
  const txMonth = txDate.getMonth() + 1;
  const txYear  = txDate.getFullYear();

  const receipts = userDoc.data().receipts || [];
  if (!receipts.some(r => r.tenantId === tenant_id && r.month === txMonth && r.year === txYear && r.status === 'received')) {
    await db.collection('users').doc(uid).update({
      receipts: admin.firestore.FieldValue.arrayUnion({
        id: `r${Date.now()}${Math.random().toString(36).slice(2,5)}`,
        tenantId: tenant_id, month: txMonth, year: txYear,
        status: 'received', source: 'bridge_manual', amount: txData.montant,
        createdAt: new Date().toISOString(),
      }),
    });
  }

  await txRef.update({ statut: 'confirme_manuel', locataire_id_match: tenant_id, traite: true });
  await db.collection('notifications').add({
    uid, type: 'loyer_confirme_manuel', tenantId: tenant_id,
    tenantName: `${tenant.first||''} ${tenant.last||''}`.trim(),
    montant: txData.montant, month: txMonth, year: txYear,
    lu: false, createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  return { success: true };
});
