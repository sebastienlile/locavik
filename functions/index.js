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

  // SÉCURITÉ: Rate limiting — 1 connexion Bridge max par minute
  const rateLimitRef = db.collection('rate_limits').doc(`bridge_${uid}`);
  const rateLimitDoc = await rateLimitRef.get();
  if (rateLimitDoc.exists) {
    const elapsed = Date.now() - rateLimitDoc.data().last_call.toMillis();
    if (elapsed < 60000) throw new HttpsError('resource-exhausted', 'Trop de requêtes. Attendez 60 secondes.');
  }
  await rateLimitRef.set({ last_call: admin.firestore.FieldValue.serverTimestamp() });

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

// ── generateBail ─────────────────────────────────────────────────────────────

function LISTE_MEUBLES_LEGALE_FN() {
  return [
    'Literie comprenant couette ou couverture',
    'Dispositif d\'occultation de la lumière dans les chambres (volets ou rideaux)',
    'Plaques de cuisson',
    'Four ou four à micro-ondes',
    'Réfrigérateur et congélateur (ou compartiment ≤ -6°C)',
    'Vaisselle nécessaire à la prise des repas',
    'Ustensiles de cuisine',
    'Table et sièges',
    'Étagères de rangement',
    'Luminaires',
    'Matériel d\'entretien ménager adapté aux caractéristiques du logement',
  ].join('\n');
}

exports.generateBail = onCall({ region: REGION }, async (request) => {
  // SÉCURITÉ: Vérifier l'auth via le contexte serveur uniquement — jamais via request.data
  if (!request.auth) throw new HttpsError('unauthenticated', 'Authentification requise');
  const uid = request.auth.uid;

  // SÉCURITÉ: Rate limiting — 1 génération de bail max par minute par utilisateur
  const rateLimitRef = db.collection('rate_limits').doc(`bail_${uid}`);
  const rateLimitDoc = await rateLimitRef.get();
  if (rateLimitDoc.exists) {
    const elapsed = Date.now() - rateLimitDoc.data().last_call.toMillis();
    if (elapsed < 60000) throw new HttpsError('resource-exhausted', 'Trop de requêtes. Attendez 60 secondes.');
  }
  await rateLimitRef.set({ last_call: admin.firestore.FieldValue.serverTimestamp() });

  const { tenantData, bailData, landlordData, propertyAddress } = request.data;

  // SÉCURITÉ: Validation stricte des paramètres entrants
  if (!bailData?.surface || bailData.surface <= 0 || bailData.surface > 9999)
    throw new HttpsError('invalid-argument', 'Surface invalide (1–9999 m²)');
  if (!bailData?.date_debut || !/^\d{4}-\d{2}-\d{2}$/.test(bailData.date_debut))
    throw new HttpsError('invalid-argument', 'Date de début invalide');
  if (!['classique', 'colocation'].includes(bailData.type_bail))
    throw new HttpsError('invalid-argument', 'type_bail invalide');
  if (typeof bailData.depot_garantie !== 'number' || bailData.depot_garantie < 0 || bailData.depot_garantie > 999999)
    throw new HttpsError('invalid-argument', 'Dépôt de garantie invalide');
  if (typeof tenantData?.rent !== 'number' || tenantData.rent < 0 || tenantData.rent > 99999)
    throw new HttpsError('invalid-argument', 'Loyer invalide');
  if (typeof tenantData?.charges !== 'number' || tenantData.charges < 0 || tenantData.charges > 99999)
    throw new HttpsError('invalid-argument', 'Charges invalides');
  if (bailData.clauses_particulieres && bailData.clauses_particulieres.length > 2000)
    throw new HttpsError('invalid-argument', 'Clauses particulières trop longues (max 2000 caractères)');

  if (!bailData?.surface) throw new HttpsError('invalid-argument', 'Surface requise');

  const PDFDocument = require('pdfkit');

  const {
    type_bail, clause_solidarite, type_logement, surface, etage, nb_pieces,
    equipements = [], date_debut, duree_bail, depot_garantie,
    modalite_paiement, jour_paiement, meuble, liste_meubles, clauses_particulieres
  } = bailData;

  const { first, last, email: tenantEmail, address: tenantAddress, rent, charges } = tenantData;
  const { name: landlordName, address: landlordAddress } = landlordData;

  const fmtDate = (iso) => {
    if (!iso) return '—';
    const d = new Date(iso + 'T00:00:00');
    return d.toLocaleDateString('fr-FR', { day: '2-digit', month: 'long', year: 'numeric' });
  };
  const today = new Date().toLocaleDateString('fr-FR', { day: '2-digit', month: 'long', year: 'numeric' });
  const totalMensuel = (rent || 0) + (charges || 0);
  const modaliteTxt = modalite_paiement === 'échoir'
    ? `à terme à échoir, le ${jour_paiement} de chaque mois`
    : `à terme échu, le ${jour_paiement} de chaque mois`;
  const equip = (equipements || []).length > 0 ? equipements.join(', ') : 'Aucune annexe';

  const pdfBuffer = await new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 55, bufferPages: true });
    const chunks = [];
    doc.on('data', chunk => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const W = doc.page.width - 110;

    const section = (title) => {
      doc.moveDown(0.8);
      doc.fontSize(10).fillColor('#8B1A3A').font('Helvetica-Bold').text(title.toUpperCase());
      doc.moveTo(55, doc.y + 2).lineTo(55 + W, doc.y + 2).strokeColor('#8B1A3A').lineWidth(0.5).stroke();
      doc.moveDown(0.3);
      doc.fillColor('#000000').font('Helvetica').fontSize(9.5);
    };
    const line = (label, value) => {
      doc.font('Helvetica-Bold').text(label + ' : ', { continued: true }).font('Helvetica').text(value || '—');
    };
    const bullet = (text) => {
      doc.text('• ' + text, { indent: 10 });
    };

    // ── PAGE 1 ──────────────────────────────────────────────────────────────
    const titre = type_bail === 'colocation' ? 'CONTRAT DE COLOCATION' : 'CONTRAT DE LOCATION';
    doc.fontSize(18).font('Helvetica-Bold').fillColor('#1A1705')
       .text(titre, { align: 'center' });
    doc.moveDown(0.3);
    doc.fontSize(9).fillColor('#6B6550').font('Helvetica')
       .text('Loi n° 89-462 du 6 juillet 1989 tendant à améliorer les rapports locatifs', { align: 'center' });
    doc.moveDown(0.2);
    doc.fontSize(8.5).text(
      meuble
        ? 'Logement meublé — Durée : ' + duree_bail
        : 'Logement non meublé — Durée : ' + duree_bail,
      { align: 'center' }
    );
    doc.moveDown(1);
    doc.fillColor('#000000');

    section('ENTRE LES SOUSSIGNÉS');
    doc.fontSize(9.5).font('Helvetica-Bold').text('BAILLEUR');
    doc.font('Helvetica');
    line('Nom', landlordName);
    line('Adresse', landlordAddress || propertyAddress);
    line('Qualité', 'Propriétaire bailleur');
    doc.moveDown(0.5);
    doc.font('Helvetica-Bold').text('LOCATAIRE');
    doc.font('Helvetica');
    line('Nom', (first || '') + ' ' + (last || ''));
    line('Adresse actuelle', tenantAddress || '—');
    if (tenantEmail) line('Email', tenantEmail);

    section('DÉSIGNATION DU LOGEMENT');
    line('Adresse du bien', propertyAddress || '—');
    line('Type', type_logement);
    line('Surface habitable', surface + ' m²');
    if (etage != null) line('Étage', etage === 0 ? 'Rez-de-chaussée' : etage + 'ème étage');
    line('Nombre de pièces principales', String(nb_pieces));
    line('Annexes', equip);
    line('Destination', "Usage exclusif d'habitation principale");
    if (meuble) line('Logement', 'Meublé');

    // ── PAGE 2 ──────────────────────────────────────────────────────────────
    doc.addPage();

    section('CONDITIONS FINANCIÈRES');
    line('Loyer mensuel hors charges', rent + ' €');
    line('Charges forfaitaires', charges + ' €');
    doc.font('Helvetica-Bold');
    line('Total mensuel', totalMensuel + ' €');
    doc.font('Helvetica');
    line(
      'Dépôt de garantie',
      depot_garantie + ' € (' + (rent > 0 ? Math.round(depot_garantie / rent * 10) / 10 : '—') + ' mois de loyer hors charges)'
    );
    line('Modalités de paiement', modaliteTxt);
    doc.moveDown(0.3);
    doc.fontSize(8.5).fillColor('#6B6550')
       .text(
         'Conformément à la loi, le dépôt de garantie ne peut excéder 1 mois de loyer hors charges ' +
         'pour un logement non meublé et 2 mois pour un logement meublé.'
       )
       .fillColor('#000000').fontSize(9.5);

    section('DURÉE DU BAIL');
    line("Prise d'effet", fmtDate(date_debut));
    line('Durée', duree_bail);
    doc.moveDown(0.3);
    doc.text(
      'Renouvellement : le contrat est renouvelé par tacite reconduction à son échéance, ' +
      'aux mêmes conditions, pour une même durée.'
    );
    doc.moveDown(0.3);
    doc.font('Helvetica-Bold').text('Résiliation par le bailleur :').font('Helvetica');
    bullet("Préavis de 6 mois avant l'échéance du bail");
    bullet('Motifs légaux : reprise pour habiter, vente du bien, motif légitime et sérieux');
    bullet('Préavis réduit à 3 mois si motif légitime sérieux ou reprise pour habiter');
    doc.moveDown(0.3);
    doc.font('Helvetica-Bold').text('Résiliation par le locataire :').font('Helvetica');
    bullet('Préavis de 3 mois à tout moment');
    bullet("Préavis réduit à 1 mois : zone tendue, mutation professionnelle, perte d'emploi, raisons de santé, attribution de logement social");

    // ── CLAUSE SOLIDARITÉ (colocation) ──────────────────────────────────────
    if (type_bail === 'colocation' && clause_solidarite) {
      doc.addPage();
      section('CLAUSE DE SOLIDARITÉ');
      doc.text(
        'Les colocataires sont tenus solidairement et indivisiblement au paiement du loyer et des charges. ' +
        "Le bailleur pourra réclamer à l'un quelconque des colocataires le paiement de la totalité des sommes dues " +
        'au titre du présent contrat, sans que celui-ci puisse opposer le bénéfice de division. ' +
        "Cette solidarité s'étend aux dommages causés au logement.",
        { lineGap: 3 }
      );
      doc.moveDown(0.3);
      doc.text(
        "En cas de départ d'un colocataire, la solidarité cesse à l'égard du partant à compter de la date de " +
        "remise des clés, sous réserve de l'accord écrit du bailleur et du remplacement dudit colocataire."
      );
    }

    // ── OBLIGATIONS ──────────────────────────────────────────────────────────
    if (doc.y > doc.page.height - 200) doc.addPage();
    section('OBLIGATIONS DU BAILLEUR');
    bullet('Délivrer au locataire un logement décent répondant aux normes minimales de confort et de sécurité');
    bullet("Assurer au locataire la jouissance paisible du logement");
    bullet("Entretenir les locaux en état de servir à l'usage prévu et y faire toutes les réparations nécessaires");
    bullet('Mettre à disposition les équipements mentionnés au contrat en bon état de fonctionnement');
    bullet("Ne pas s'opposer aux aménagements réalisés par le locataire ne constituant pas une transformation");

    section('OBLIGATIONS DU LOCATAIRE');
    bullet('Payer le loyer et les charges aux termes convenus');
    bullet('User paisiblement des locaux loués suivant leur destination');
    bullet('Répondre des dégradations et pertes survenues pendant la durée du contrat');
    bullet('Souscrire une assurance habitation couvrant les risques locatifs et en justifier annuellement');
    bullet('Ne pas sous-louer le logement sans accord écrit et exprès du bailleur');
    bullet("Permettre l'accès aux locaux pour les travaux d'amélioration ou d'entretien urgents");
    bullet('Laisser visiter le logement en cas de mise en vente ou en location (2h par jour ouvrable)');
    bullet("Restituer le logement en bon état d'entretien à la fin du bail");

    // ── LISTE MEUBLES ────────────────────────────────────────────────────────
    if (meuble) {
      doc.addPage();
      section('LISTE DES MEUBLES ET ÉQUIPEMENTS (Décret du 31 juillet 2015)');
      doc.text(
        'Conformément au décret n° 2015-981 du 31 juillet 2015, le logement est fourni avec les équipements suivants :'
      );
      doc.moveDown(0.4);
      const meubles = (liste_meubles || LISTE_MEUBLES_LEGALE_FN()).split('\n');
      meubles.forEach(m => { if (m.trim()) bullet(m.trim()); });
    }

    // ── CLAUSES DIVERSES ─────────────────────────────────────────────────────
    if (doc.y > doc.page.height - 250) doc.addPage();
    section('CLAUSES DIVERSES');
    doc.font('Helvetica-Bold').text('Assurance habitation').font('Helvetica');
    doc.text(
      "Le locataire est tenu de souscrire une assurance contre les risques locatifs (incendie, dégât des eaux, etc.) " +
      "auprès d'une compagnie d'assurance de son choix et d'en justifier annuellement."
    );
    doc.moveDown(0.4);
    doc.font('Helvetica-Bold').text('Entretien et réparations').font('Helvetica');
    doc.text(
      "Le locataire prend à sa charge l'entretien courant du logement, les menues réparations et les réparations " +
      'locatives définies par décret. Le bailleur prend en charge les grosses réparations.'
    );
    doc.moveDown(0.4);
    doc.font('Helvetica-Bold').text('Sous-location').font('Helvetica');
    doc.text('Toute sous-location totale ou partielle est strictement interdite sans accord écrit préalable du bailleur.');

    if (clauses_particulieres) {
      doc.moveDown(0.5);
      doc.font('Helvetica-Bold').text('Clauses particulières').font('Helvetica');
      const cpHeight = doc.heightOfString(clauses_particulieres, { width: W - 20 });
      doc.rect(55, doc.y + 4, W, cpHeight + 16).fillAndStroke('#F8F7F3', '#E0DDD5');
      doc.fillColor('#1A1705').text(clauses_particulieres, 65, doc.y + 4 + 8, { width: W - 20 });
      doc.moveDown(0.3);
      doc.fillColor('#000000');
    }

    // ── SIGNATURES ───────────────────────────────────────────────────────────
    doc.addPage();
    section('SIGNATURES');
    doc.text('Fait à _________________, le ' + today);
    doc.text('En deux exemplaires originaux, dont un remis à chaque partie.');
    doc.moveDown(1.5);

    const sigWidth = (W - 30) / 2;

    doc.font('Helvetica-Bold').text('LE BAILLEUR', 55, doc.y, { width: sigWidth });
    const sigY = doc.y;
    doc.font('Helvetica-Bold').text('LE LOCATAIRE', 55 + sigWidth + 30, sigY, { width: sigWidth });
    doc.moveDown(0.3);

    doc.font('Helvetica').fontSize(9).text(landlordName || '—', 55, doc.y, { width: sigWidth });
    doc.text((first || '') + ' ' + (last || ''), 55 + sigWidth + 30, doc.y, { width: sigWidth });
    doc.moveDown(0.3);

    doc.text('Lu et approuvé — Bon pour accord :', 55 + sigWidth + 30, doc.y, { width: sigWidth });
    doc.moveDown(0.3);

    const lineY1 = doc.y + 30;
    doc.moveTo(55, lineY1).lineTo(55 + sigWidth - 10, lineY1)
       .strokeColor('#000000').dash(2, { space: 3 }).stroke().undash();
    doc.moveTo(55 + sigWidth + 30, lineY1).lineTo(55 + W, lineY1)
       .dash(2, { space: 3 }).stroke().undash();
    doc.moveDown(3.5).fontSize(9.5);

    // ── FOOTER sur chaque page ───────────────────────────────────────────────
    const totalPages = doc.bufferedPageRange().count;
    for (let i = 0; i < totalPages; i++) {
      doc.switchToPage(i);
      doc.fontSize(7.5).fillColor('#9B9B9B').font('Helvetica')
         .text(
           'Bail généré via Locavik · ' + today + ' · Page ' + (i + 1) + '/' + totalPages,
           55, doc.page.height - 35, { width: W, align: 'center' }
         );
    }

    doc.end();
  });

  return { success: true, pdf_base64: pdfBuffer.toString('base64') };
});

