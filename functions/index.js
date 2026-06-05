/**
 * Locavik — Firebase Cloud Functions v2
 * Bridge API v3 — flow validé :
 *   POST /v3/aggregation/users                   → créer utilisateur Bridge
 *   POST /v3/aggregation/authorization/token     → access_token (2h)
 *   POST /v3/aggregation/connect-sessions        → URL session Connect
 *   GET  /v3/aggregation/accounts                → comptes bancaires
 *   GET  /v3/aggregation/transactions            → transactions
 */

'use strict';

const { onCall, onRequest, HttpsError } = require('firebase-functions/v2/https');
const { onSchedule }                    = require('firebase-functions/v2/scheduler');
const { logger }                        = require('firebase-functions');
const admin                             = require('firebase-admin');
const axios                             = require('axios');
const crypto                            = require('crypto');

admin.initializeApp();
const db = admin.firestore();

const REGION     = 'europe-west1';
const BRIDGE_API = 'https://api.bridgeapi.io';
const BRIDGE_VER = '2025-01-15';

const appHeaders = () => ({
  'Client-Id':      process.env.BRIDGE_CLIENT_ID     || '',
  'Client-Secret':  process.env.BRIDGE_CLIENT_SECRET || '',
  'Bridge-Version': BRIDGE_VER,
  'Content-Type':   'application/json',
  'accept':         'application/json',
});

const userHeaders = (token) => ({ ...appHeaders(), Authorization: `Bearer ${token}` });

// ── Helpers matching ────────────────────────────────────────────────────────

function normalize(str) {
  return (str || '').toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

function matchScore(label, first, last, rent, charges, amount) {
  const normLabel  = normalize(label);
  const nameTokens = [...normalize(first).split(' '), ...normalize(last).split(' ')].filter(t => t.length > 1);
  const labelToks  = normLabel.split(' ');
  let score = 0;
  const matches = nameTokens.filter(tok => labelToks.some(lt => lt.includes(tok) || tok.includes(lt))).length;
  score += nameTokens.length > 0 ? Math.round((matches / nameTokens.length) * 50) : 0;
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

// ── Gestion token Bridge ────────────────────────────────────────────────────

async function getOrCreateBridgeUser(uid, userEmail) {
  const tokenDoc = await db.collection('bridge_tokens').doc(uid).get();
  if (tokenDoc.exists && tokenDoc.data().bridge_user_uuid) {
    return tokenDoc.data();
  }

  // Créer l'utilisateur Bridge v3
  const externalId = `locavik_${uid}`;
  const res = await axios.post(
    `${BRIDGE_API}/v3/aggregation/users`,
    { external_user_id: externalId },
    { headers: appHeaders() }
  );
  const { uuid } = res.data;

  const data = { bridge_user_uuid: uuid, external_user_id: externalId, user_email: userEmail || '', firebase_uid: uid };
  await db.collection('bridge_tokens').doc(uid).set(data, { merge: true });
  return { ...tokenDoc.data(), ...data };
}

async function getAccessToken(uid) {
  const tokenDoc = await db.collection('bridge_tokens').doc(uid).get();
  if (!tokenDoc.exists) throw new Error('Utilisateur Bridge non trouvé.');

  const d = tokenDoc.data();
  const expiresAt = d.expires_at?.toDate?.();
  if (expiresAt && expiresAt - Date.now() > 5 * 60 * 1000 && d.access_token) {
    return d.access_token;
  }

  // Ré-authentifier via uuid
  const res = await axios.post(
    `${BRIDGE_API}/v3/aggregation/authorization/token`,
    { user_uuid: d.bridge_user_uuid },
    { headers: appHeaders() }
  );
  const { access_token, expires_at } = res.data;
  await db.collection('bridge_tokens').doc(uid).update({
    access_token,
    bridge_user_uuid: res.data.user?.uuid || d.bridge_user_uuid,
    expires_at: admin.firestore.Timestamp.fromDate(new Date(expires_at)),
  });
  return access_token;
}

// ── FONCTION 1 — getBridgeConnectUrl ──────────────────────────────────────

exports.getBridgeConnectUrl = onCall({ region: REGION }, async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Authentification requise.');
  const uid       = request.auth.uid;
  const userEmail = request.auth.token.email || '';

  try {
    await getOrCreateBridgeUser(uid, userEmail);
    const token = await getAccessToken(uid);

    const res = await axios.post(
      `${BRIDGE_API}/v3/aggregation/connect-sessions`,
      { user_email: userEmail },
      { headers: userHeaders(token) }
    );
    return { url: res.data.url };
  } catch (e) {
    logger.error('getBridgeConnectUrl:', e.response?.data || e.message);
    throw new HttpsError('internal', e.response?.data?.errors?.[0]?.message || e.message);
  }
});

// ── FONCTION 2 — syncTransactions ─────────────────────────────────────────

async function runSync(uid = null) {
  let query = db.collection('bridge_tokens');
  if (uid) query = query.where('firebase_uid', '==', uid);
  const snap = await query.get();
  if (snap.empty) return { synced: 0 };

  let total = 0;

  for (const tokenDoc of snap.docs) {
    const userId = tokenDoc.id;
    let token;
    try { token = await getAccessToken(userId); } catch (e) { continue; }

    const userDoc = await db.collection('users').doc(userId).get();
    if (!userDoc.exists) continue;
    const tenants = (userDoc.data().tenants || []).filter(t => t.active);

    const since = new Date(); since.setDate(since.getDate() - 35);
    let transactions = [];
    try {
      const res = await axios.get(`${BRIDGE_API}/v3/aggregation/transactions`, {
        headers: userHeaders(token),
        params: { since: since.toISOString().split('T')[0], limit: 200 },
      });
      transactions = res.data?.resources || res.data?.items || res.data || [];
    } catch (e) {
      logger.error(`Transactions ${userId}:`, e.response?.data || e.message);
      continue;
    }

    for (const tx of transactions.filter(t => (t.amount || 0) > 0)) {
      const txId = String(tx.id);
      const existing = await db.collection('transactions_bancaires')
        .where('bridge_transaction_id', '==', txId)
        .where('locavik_uid', '==', userId).limit(1).get();
      if (!existing.empty && existing.docs[0].data().traite) continue;

      let best = 0, bestTenant = null;
      for (const t of tenants) {
        const s = matchScore(tx.label || tx.description || '', t.first || '', t.last || '', t.rent, t.charges, tx.amount);
        if (s > best) { best = s; bestTenant = t; }
      }

      const txDate  = new Date(tx.date || tx.transaction_date || tx.booking_date);
      const txMonth = txDate.getMonth() + 1;
      const txYear  = txDate.getFullYear();
      let statut = 'non_reconnu', matchId = null;

      if (best >= 80 && bestTenant) {
        statut = 'auto_valide'; matchId = bestTenant.id;
        if (bestTenant.auto_validation !== false) {
          const receipts = userDoc.data().receipts || [];
          if (!receipts.some(r => r.tenantId === bestTenant.id && r.month === txMonth && r.year === txYear && r.status === 'received')) {
            await db.collection('users').doc(userId).update({
              receipts: admin.firestore.FieldValue.arrayUnion({
                id: `r${Date.now()}${Math.random().toString(36).slice(2,5)}`,
                tenantId: bestTenant.id, month: txMonth, year: txYear,
                status: 'received', source: 'bridge_auto', amount: tx.amount,
                createdAt: new Date().toISOString(),
              }),
            });
            await db.collection('notifications').add({
              uid: userId, type: 'loyer_auto_valide', tenantId: bestTenant.id,
              tenantName: `${bestTenant.first||''} ${bestTenant.last||''}`.trim(),
              montant: tx.amount, month: txMonth, year: txYear,
              lu: false, createdAt: admin.firestore.FieldValue.serverTimestamp(),
            });
          }
        }
      } else if (best >= 50 && bestTenant) {
        statut = 'a_confirmer'; matchId = bestTenant.id;
        await db.collection('notifications').add({
          uid: userId, type: 'loyer_a_confirmer', tenantId: bestTenant.id,
          tenantName: `${bestTenant.first||''} ${bestTenant.last||''}`.trim(),
          montant: tx.amount, libelle: tx.label || '', score: best,
          month: txMonth, year: txYear, bridge_tx_id: txId,
          lu: false, createdAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      }

      const ref = existing.empty ? db.collection('transactions_bancaires').doc() : existing.docs[0].ref;
      await ref.set({
        bridge_transaction_id: txId, locavik_uid: userId,
        date: admin.firestore.Timestamp.fromDate(txDate),
        montant: tx.amount, libelle: tx.label || tx.description || '',
        locataire_id_match: matchId, score_matching: best,
        statut, traite: statut === 'auto_valide',
        synced_at: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
      total++;
    }

    await db.collection('bridge_tokens').doc(userId).update({
      last_sync: admin.firestore.FieldValue.serverTimestamp(),
    });
  }
  return { synced: total };
}

exports.syncTransactions = onSchedule({ schedule: 'every 6 hours', region: REGION }, async () => {
  logger.info('Sync Bridge planifiée');
  const r = await runSync();
  logger.info(`Sync terminée — ${r.synced} transactions`);
});

exports.syncTransactionsManual = onCall({ region: REGION }, async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Authentification requise.');
  return runSync(request.auth.uid);
});

// ── FONCTION 3 — disconnectBridge ─────────────────────────────────────────

exports.disconnectBridge = onCall({ region: REGION }, async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Authentification requise.');
  const uid = request.auth.uid;
  const doc = await db.collection('bridge_tokens').doc(uid).get();
  if (doc.exists) {
    try {
      const token = await getAccessToken(uid);
      const items = await axios.get(`${BRIDGE_API}/v3/aggregation/items`, { headers: userHeaders(token) });
      for (const item of (items.data?.resources || [])) {
        await axios.delete(`${BRIDGE_API}/v3/aggregation/items/${item.id}`, { headers: userHeaders(token) });
      }
    } catch (_) {}
    await db.collection('bridge_tokens').doc(uid).delete();
  }
  return { success: true };
});

// ── FONCTION 4 — getBridgeStatus ──────────────────────────────────────────

exports.getBridgeStatus = onCall({ region: REGION }, async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Authentification requise.');
  const uid = request.auth.uid;
  const doc = await db.collection('bridge_tokens').doc(uid).get();
  if (!doc.exists || !doc.data().bridge_user_uuid) return { connected: false };

  let bankName = '—', ibanLast4 = '????', connected = false;
  try {
    const token   = await getAccessToken(uid);
    const itemRes = await axios.get(`${BRIDGE_API}/v3/aggregation/items`, { headers: userHeaders(token) });
    const items   = itemRes.data?.resources || itemRes.data?.items || [];
    if (items.length === 0) return { connected: false };
    connected = true;
    bankName  = items[0].bank?.name || items[0].name || 'Banque';

    const accRes  = await axios.get(`${BRIDGE_API}/v3/aggregation/accounts`, { headers: userHeaders(token) });
    const accounts = accRes.data?.resources || accRes.data?.items || [];
    if (accounts.length > 0) ibanLast4 = (accounts[0].iban || '').slice(-4) || '????';

    await db.collection('bridge_tokens').doc(uid).update({ banque_nom: bankName, iban_partiel: ibanLast4 });
  } catch (e) {
    if (!doc.data().banque_nom) return { connected: false };
    bankName  = doc.data().banque_nom || '—';
    ibanLast4 = doc.data().iban_partiel || '????';
    connected = true;
  }

  const monthStart = new Date(); monthStart.setDate(1); monthStart.setHours(0,0,0,0);
  const txSnap = await db.collection('transactions_bancaires')
    .where('locavik_uid', '==', uid)
    .where('date', '>=', admin.firestore.Timestamp.fromDate(monthStart)).get();

  return {
    connected, banque_nom: bankName, iban_partiel: ibanLast4,
    last_sync:   doc.data().last_sync ? doc.data().last_sync.toDate().toISOString() : null,
    tx_ce_mois: txSnap.size,
    tx_matches: txSnap.docs.filter(d => d.data().statut === 'auto_valide').length,
  };
});

// ── FONCTION 5 — bridgeWebhook ────────────────────────────────────────────

exports.bridgeWebhook = onRequest({ region: REGION }, async (req, res) => {
  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');
  const event = req.body;
  logger.info('Bridge webhook:', event?.type, event?.user_uuid);
  try {
    const userUuid = event?.user_uuid || event?.data?.user_uuid;
    if (userUuid && (event?.type || '').match(/item|transaction/)) {
      const snap = await db.collection('bridge_tokens')
        .where('bridge_user_uuid', '==', userUuid).limit(1).get();
      if (!snap.empty) await runSync(snap.docs[0].id);
    }
    return res.status(200).json({ received: true });
  } catch (e) {
    logger.error('Webhook error:', e.message);
    return res.status(500).json({ error: e.message });
  }
});

// ── FONCTION 6 — confirmTransaction ──────────────────────────────────────

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
