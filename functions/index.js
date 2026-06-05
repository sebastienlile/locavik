/**
 * Locavik — Firebase Cloud Functions v2
 * Intégration Bridge API — flow correct :
 * 1. Créer un utilisateur Bridge par bailleur (POST /v2/users)
 * 2. Authentifier → access_token (POST /v2/authenticate)
 * 3. Générer l'URL Bridge Connect avec le token
 * 4. Après connexion bancaire, sync les transactions
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

const REGION      = 'europe-west1';
const BRIDGE_API  = 'https://api.bridgeapi.io';
const BRIDGE_CONN = 'https://connect.bridgeapi.io';
const BRIDGE_VER  = '2021-06-01';

const cfg = () => ({
  client_id:     process.env.BRIDGE_CLIENT_ID     || '',
  client_secret: process.env.BRIDGE_CLIENT_SECRET || '',
  redirect_uri:  process.env.BRIDGE_REDIRECT_URI  || 'https://locavik.com/dashboard.html',
});

// ── Helpers ────────────────────────────────────────────────────────────────

function bridgeHeaders(accessToken) {
  return {
    Authorization:    `Bearer ${accessToken}`,
    'Bridge-Version': BRIDGE_VER,
    'Content-Type':   'application/json',
  };
}

function appHeaders() {
  const { client_id, client_secret } = cfg();
  return {
    'Client-Id':      client_id,
    'Client-Secret':  client_secret,
    'Bridge-Version': BRIDGE_VER,
    'Content-Type':   'application/json',
  };
}

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

// ── Gestion utilisateur Bridge ─────────────────────────────────────────────

/**
 * Crée ou récupère l'utilisateur Bridge associé au Firebase uid.
 * Stocke email + mdp générés dans bridge_tokens (jamais exposé au frontend).
 */
async function getOrCreateBridgeUser(uid, userEmail) {
  const tokenDoc = await db.collection('bridge_tokens').doc(uid).get();

  // Utilisateur Bridge déjà créé
  if (tokenDoc.exists && tokenDoc.data().bridge_email) {
    return tokenDoc.data();
  }

  // Générer email/mdp uniques pour cet utilisateur Bridge
  const bridgeEmail = `locavik_${uid.slice(0,8)}@bridge-user.locavik.com`;
  const bridgePwd   = crypto.randomBytes(24).toString('hex');

  const { client_id, client_secret } = cfg();

  // Créer l'utilisateur Bridge
  try {
    await axios.post(`${BRIDGE_API}/v2/users`, {
      email:    bridgeEmail,
      password: bridgePwd,
    }, { headers: appHeaders() });
    logger.info(`Utilisateur Bridge créé : ${bridgeEmail}`);
  } catch (e) {
    // 409 = déjà existant → on continue
    if (e.response?.status !== 409) {
      logger.error('Création Bridge user:', e.response?.data || e.message);
      throw e;
    }
  }

  // Sauvegarder en Firestore
  await db.collection('bridge_tokens').doc(uid).set({
    bridge_email:  bridgeEmail,
    bridge_pwd:    bridgePwd,
    firebase_uid:  uid,
    user_email:    userEmail || '',
    created_at:    admin.firestore.FieldValue.serverTimestamp(),
  }, { merge: true });

  return { bridge_email: bridgeEmail, bridge_pwd: bridgePwd };
}

/**
 * Authentifie l'utilisateur Bridge → retourne un access_token frais.
 */
async function authenticateBridgeUser(uid) {
  const tokenDoc = await db.collection('bridge_tokens').doc(uid).get();
  if (!tokenDoc.exists) throw new Error('Utilisateur Bridge non trouvé.');

  const { bridge_email, bridge_pwd } = tokenDoc.data();

  // Token encore valide ?
  const expiresAt = tokenDoc.data().expires_at?.toDate?.();
  if (expiresAt && expiresAt - Date.now() > 5 * 60 * 1000) {
    return tokenDoc.data().access_token;
  }

  // Ré-authentifier
  const res = await axios.post(`${BRIDGE_API}/v2/authenticate`, {
    email:    bridge_email,
    password: bridge_pwd,
  }, { headers: appHeaders() });

  const { access_token, expires_at } = res.data;
  const expiresDate = new Date(expires_at || Date.now() + 3600 * 1000);

  await db.collection('bridge_tokens').doc(uid).update({
    access_token,
    expires_at:  admin.firestore.Timestamp.fromDate(expiresDate),
    last_auth:   admin.firestore.FieldValue.serverTimestamp(),
  });

  return access_token;
}

// ── FONCTION 1 — getBridgeConnectUrl ──────────────────────────────────────
/**
 * Callable. Crée l'utilisateur Bridge si besoin, l'authentifie,
 * retourne l'URL Bridge Connect personnalisée.
 */
exports.getBridgeConnectUrl = onCall({ region: REGION }, async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Authentification requise.');

  const uid       = request.auth.uid;
  const userEmail = request.auth.token.email || '';
  const { client_id, redirect_uri } = cfg();

  if (!client_id) throw new HttpsError('failed-precondition', 'Bridge non configuré.');

  try {
    // 1. Créer ou récupérer l'utilisateur Bridge
    await getOrCreateBridgeUser(uid, userEmail);

    // 2. Authentifier → obtenir access_token
    const accessToken = await authenticateBridgeUser(uid);

    // 3. Construire l'URL Bridge Connect
    const params = new URLSearchParams({
      bridge_token: accessToken,
      redirect_uri,
      context:      'items',
    });
    const connectUrl = `${BRIDGE_CONN}/v2/connect?${params.toString()}`;

    return { url: connectUrl };
  } catch (e) {
    logger.error('getBridgeConnectUrl:', e.response?.data || e.message);
    throw new HttpsError('internal', e.response?.data?.message || e.message);
  }
});

// ── FONCTION 2 — syncTransactions (logique partagée) ──────────────────────

async function runSync(uid = null) {
  let query = db.collection('bridge_tokens');
  if (uid) query = query.where('firebase_uid', '==', uid);
  const snap = await query.get();
  if (snap.empty) return { synced: 0 };

  let total = 0;

  for (const tokenDoc of snap.docs) {
    const userId = tokenDoc.id;

    let accessToken;
    try {
      accessToken = await authenticateBridgeUser(userId);
    } catch (e) {
      logger.warn(`Auth Bridge échouée pour ${userId}:`, e.message);
      continue;
    }

    const userDoc = await db.collection('users').doc(userId).get();
    if (!userDoc.exists) continue;
    const tenants = (userDoc.data().tenants || []).filter(t => t.active);

    // Transactions 35 derniers jours
    const since = new Date(); since.setDate(since.getDate() - 35);
    let transactions = [];
    try {
      const res = await axios.get(`${BRIDGE_API}/v2/transactions`, {
        headers: bridgeHeaders(accessToken),
        params:  { since: since.toISOString().split('T')[0], limit: 200 },
      });
      transactions = res.data?.resources || res.data || [];
    } catch (e) {
      logger.error(`Transactions ${userId}:`, e.response?.data || e.message);
      continue;
    }

    for (const tx of transactions.filter(t => t.amount > 0)) {
      const txId = String(tx.id);
      const existing = await db.collection('transactions_bancaires')
        .where('bridge_transaction_id', '==', txId)
        .where('locavik_uid', '==', userId).limit(1).get();
      if (!existing.empty && existing.docs[0].data().traite) continue;

      // Matching locataire
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
        date:    admin.firestore.Timestamp.fromDate(txDate),
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
      const token = await authenticateBridgeUser(uid);
      // Supprimer les items (comptes bancaires connectés)
      const itemsRes = await axios.get(`${BRIDGE_API}/v2/items`, { headers: bridgeHeaders(token) });
      const items = itemsRes.data?.resources || [];
      for (const item of items) {
        await axios.delete(`${BRIDGE_API}/v2/items/${item.id}`, { headers: bridgeHeaders(token) });
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
  if (!doc.exists || !doc.data().access_token) return { connected: false };

  const d = doc.data();

  // Vérifier qu'il y a au moins un item (compte) connecté
  let bankName = d.banque_nom || 'Banque', ibanLast4 = d.iban_partiel || '????';
  try {
    const token   = await authenticateBridgeUser(uid);
    const accRes  = await axios.get(`${BRIDGE_API}/v2/accounts`, { headers: bridgeHeaders(token) });
    const accounts = accRes.data?.resources || accRes.data || [];
    if (accounts.length === 0) return { connected: false };
    if (accounts[0].bank?.name) bankName = accounts[0].bank.name;
    if (accounts[0].iban)       ibanLast4 = accounts[0].iban.slice(-4);

    // Mettre à jour les infos banque
    await db.collection('bridge_tokens').doc(uid).update({
      banque_nom: bankName, iban_partiel: ibanLast4,
    });
  } catch (_) {
    if (!d.banque_nom) return { connected: false };
  }

  const monthStart = new Date(); monthStart.setDate(1); monthStart.setHours(0,0,0,0);
  const txSnap = await db.collection('transactions_bancaires')
    .where('locavik_uid', '==', uid)
    .where('date', '>=', admin.firestore.Timestamp.fromDate(monthStart)).get();

  return {
    connected:    true,
    banque_nom:   bankName,
    iban_partiel: ibanLast4,
    last_sync:    d.last_sync ? d.last_sync.toDate().toISOString() : null,
    tx_ce_mois:  txSnap.size,
    tx_matches:  txSnap.docs.filter(d => d.data().statut === 'auto_valide').length,
  };
});

// ── FONCTION 5 — confirmTransaction ───────────────────────────────────────

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
