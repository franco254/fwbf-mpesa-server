const express = require("express");
const axios   = require("axios");
const admin   = require("firebase-admin");

const app  = express();
app.use(express.json());

/* ── CORS — allow WebView & any origin ── */
app.use((req, res, next) => {
  res.set("Access-Control-Allow-Origin",  "*");
  res.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

/* ── Firebase Admin (service account from env var) ── */
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});
const db = admin.firestore();

/* ── M-Pesa config from environment variables ── */
const CONSUMER_KEY    = process.env.MPESA_CONSUMER_KEY;
const CONSUMER_SECRET = process.env.MPESA_CONSUMER_SECRET;
const SHORTCODE       = process.env.MPESA_SHORTCODE    || "174379";
const PASSKEY         = process.env.MPESA_PASSKEY;
const MPESA_ENV       = process.env.MPESA_ENV          || "sandbox";
const BASE_URL        = MPESA_ENV === "production"
  ? "https://api.safaricom.co.ke"
  : "https://sandbox.safaricom.co.ke";
const SERVER_URL      = process.env.RENDER_EXTERNAL_URL || process.env.SERVER_URL;

/* ════════════════════════════════════════════════════
   HELPERS
════════════════════════════════════════════════════ */
async function getToken() {
  const creds = Buffer.from(`${CONSUMER_KEY}:${CONSUMER_SECRET}`).toString("base64");
  const { data } = await axios.get(
    `${BASE_URL}/oauth/v1/generate?grant_type=client_credentials`,
    { headers: { Authorization: `Basic ${creds}` } }
  );
  return data.access_token;
}

function buildPassword() {
  const now = new Date();
  const ts =
    now.getFullYear() +
    String(now.getMonth() + 1).padStart(2, "0") +
    String(now.getDate()).padStart(2, "0") +
    String(now.getHours()).padStart(2, "0") +
    String(now.getMinutes()).padStart(2, "0") +
    String(now.getSeconds()).padStart(2, "0");
  const pwd = Buffer.from(`${SHORTCODE}${PASSKEY}${ts}`).toString("base64");
  return { ts, pwd };
}

function normalizePhone(phone) {
  let p = phone.replace(/\s+/g, "").replace(/^0/, "254").replace(/^\+/, "");
  if (!/^254[71]\d{8}$/.test(p)) return null;
  return p;
}

/* ════════════════════════════════════════════════════
   POST /stkPush
   Body: { phone, amount, uid, monthKey, type, fineId }
════════════════════════════════════════════════════ */
app.post("/stkPush", async (req, res) => {
  const { phone, amount, uid, monthKey, type = "contribution", fineId } = req.body;

  if (!phone || !amount || !uid)
    return res.status(400).json({ success: false, error: "Missing phone, amount or uid" });

  const normalized = normalizePhone(phone);
  if (!normalized)
    return res.status(400).json({ success: false, error: "Invalid phone. Use 07XXXXXXXX format." });

  try {
    const token        = await getToken();
    const { ts, pwd }  = buildPassword();
    const callbackUrl  = `${SERVER_URL}/mpesaCallback`;
    const description  = type === "fine" ? "FWBF Fine Payment" : "FWBF Monthly Contribution";

    const { data } = await axios.post(
      `${BASE_URL}/mpesa/stkpush/v1/processrequest`,
      {
        BusinessShortCode: SHORTCODE,
        Password:          pwd,
        Timestamp:         ts,
        TransactionType:   "CustomerPayBillOnline",
        Amount:            Math.round(amount),
        PartyA:            normalized,
        PartyB:            SHORTCODE,
        PhoneNumber:       normalized,
        CallBackURL:       callbackUrl,
        AccountReference:  "FWBF",
        TransactionDesc:   description,
      },
      { headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" } }
    );

    if (data.ResponseCode !== "0")
      return res.status(400).json({ success: false, error: data.ResponseDescription });

    /* save pending transaction */
    await db.collection("pending_payments").doc(data.CheckoutRequestID).set({
      uid,
      phone:      normalized,
      amount:     Math.round(amount),
      monthKey:   monthKey || null,
      type,
      fineId:     fineId || null,
      checkoutRequestId: data.CheckoutRequestID,
      status:     "pending",
      createdAt:  admin.firestore.FieldValue.serverTimestamp(),
    });

    return res.json({
      success:           true,
      checkoutRequestId: data.CheckoutRequestID,
      message:           data.CustomerMessage || "Check your phone and enter your M-PESA PIN.",
    });

  } catch (err) {
    console.error("stkPush error:", err.response?.data || err.message);
    return res.status(500).json({
      success: false,
      error:   err.response?.data?.errorMessage || err.message,
    });
  }
});

/* ════════════════════════════════════════════════════
   POST /mpesaCallback
   Called by Safaricom after payment succeeds / fails
════════════════════════════════════════════════════ */
app.post("/mpesaCallback", async (req, res) => {
  // Always respond 200 immediately so Safaricom doesn't retry
  res.status(200).json({ ResultCode: 0, ResultDesc: "Accepted" });

  try {
    const cb = req.body?.Body?.stkCallback;
    if (!cb) return;

    const { CheckoutRequestID, ResultCode, ResultDesc, CallbackMetadata } = cb;
    const pendingRef  = db.collection("pending_payments").doc(CheckoutRequestID);
    const pendingSnap = await pendingRef.get();
    if (!pendingSnap.exists()) return;

    const pending = pendingSnap.data();

    if (ResultCode !== 0) {
      await pendingRef.update({
        status:     "failed",
        resultCode: ResultCode,
        resultDesc: ResultDesc,
        updatedAt:  admin.firestore.FieldValue.serverTimestamp(),
      });
      return;
    }

    /* extract M-Pesa metadata */
    const items      = CallbackMetadata?.Item || [];
    const meta       = (name) => items.find((i) => i.Name === name)?.Value;
    const receipt    = meta("MpesaReceiptNumber");
    const txDate     = String(meta("TransactionDate") || "");
    const phoneUsed  = meta("PhoneNumber");
    const amountPaid = meta("Amount");

    const formattedDate = txDate.length === 14
      ? `${txDate.slice(6,8)}/${txDate.slice(4,6)}/${txDate.slice(0,4)}`
      : new Date().toLocaleDateString("en-KE");

    if (pending.type === "fine" && pending.fineId) {
      await db.collection("fines").doc(pending.fineId).update({
        paid:     true,
        paidAt:   admin.firestore.FieldValue.serverTimestamp(),
        paidVia:  String(phoneUsed || pending.phone),
        mpesaRef: receipt || CheckoutRequestID,
      });
    } else {
      await db.collection("payments").add({
        uid:      pending.uid,
        monthKey: pending.monthKey,
        amount:   amountPaid || pending.amount,
        date:     formattedDate,
        ref:      receipt || CheckoutRequestID,
        phone:    String(phoneUsed || pending.phone),
        paidAt:   admin.firestore.FieldValue.serverTimestamp(),
        source:   "mpesa",
      });
    }

    await pendingRef.update({
      status:    "complete",
      mpesaRef:  receipt,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

  } catch (err) {
    console.error("Callback error:", err.message);
  }
});

/* ════════════════════════════════════════════════════
   GET /checkPaymentStatus?checkoutRequestId=xxx
   App polls this every 3 seconds
════════════════════════════════════════════════════ */
app.get("/checkPaymentStatus", async (req, res) => {
  const { checkoutRequestId } = req.query;
  if (!checkoutRequestId)
    return res.status(400).json({ success: false, error: "Missing checkoutRequestId" });

  try {
    const snap = await db.collection("pending_payments").doc(checkoutRequestId).get();
    if (!snap.exists())
      return res.status(404).json({ success: false, error: "Transaction not found" });

    const d = snap.data();
    return res.json({
      success:    true,
      status:     d.status,
      mpesaRef:   d.mpesaRef  || null,
      resultDesc: d.resultDesc || null,
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

/* ── Health check ── */
app.get("/", (_, res) => res.json({ status: "FWBF M-Pesa Server running ✓" }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
