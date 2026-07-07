<?php
/**
 * ============================================================================
 *  CONTOH untuk OPERATOR situs — Handler callback deposit QRIS Kita
 * ============================================================================
 *
 *  ⚠️ File ini BUKAN untuk penyedia payment. Ini CONTOH yang diberikan ke
 *     operator/pemilik situs, untuk dipasang di SERVER MEREKA. Merekalah yang
 *     tahu skema tabel saldo dan menyesuaikan creditUserBalance().
 *
 *  QRIS Kita akan mem-POST endpoint ini saat pembayaran LUNAS (URL diisi
 *  penyedia ke setelan "depositApiUrl" pada client di dashboard QRIS Kita).
 *
 *  Payload JSON yang dikirim:
 *  {
 *    "qrId":"...", "transactionId":"...", "userId":"<username>",
 *    "requestedAmount":20000, "finalAmount":20002, "paidAmount":20002,
 *    "note":"...", "issuerName":"...", "rrn":"...",
 *    "paidAt":"2026-07-06T...Z", "externalReference":null
 *  }
 *
 *  Header keamanan yang dikirim (bila depositApiKey diisi di dashboard):
 *    X-Deposit-Timestamp: <unix seconds>
 *    X-Deposit-Signature: hex( HMAC_SHA256( "<timestamp>.<raw_body>", depositApiKey ) )
 *
 *  Balas HTTP 2xx bila sukses. Balas non-2xx supaya QRIS Kita retry
 *  (ada retry + idempotency di sisi QRIS Kita).
 * ============================================================================
 */

// Shared secret yang WAJIB sama dengan "depositApiKey" pada client di dashboard
// QRIS Kita. Minta nilai ini dari penyedia payment.
$DEPOSIT_API_KEY = 'MINTA_DARI_PENYEDIA_PAYMENT';

// Toleransi selisih waktu (detik) untuk mencegah replay.
$MAX_SKEW_SECONDS = 300;

header('Content-Type: application/json');

function fail($code, $msg) {
    http_response_code($code);
    echo json_encode(['success' => false, 'error' => $msg]);
    exit;
}

// ── 1. Baca body mentah (harus mentah, untuk verifikasi signature) ───────────
$rawBody = file_get_contents('php://input');

// ── 2. Verifikasi signature HMAC ─────────────────────────────────────────────
$timestamp = $_SERVER['HTTP_X_DEPOSIT_TIMESTAMP'] ?? '';
$signature = $_SERVER['HTTP_X_DEPOSIT_SIGNATURE'] ?? '';

if ($timestamp === '' || $signature === '') {
    fail(401, 'Signature tidak ada');
}
if (abs(time() - (int) $timestamp) > $MAX_SKEW_SECONDS) {
    fail(401, 'Timestamp kedaluwarsa');
}

$expected = hash_hmac('sha256', $timestamp . '.' . $rawBody, $DEPOSIT_API_KEY);
if (!hash_equals($expected, (string) $signature)) {
    fail(401, 'Signature tidak valid');
}

// ── 3. Parse payload ─────────────────────────────────────────────────────────
$data = json_decode($rawBody, true);
if (!is_array($data)) {
    fail(400, 'Payload bukan JSON');
}

$qrId          = (string) ($data['qrId'] ?? '');
$transactionId = (string) ($data['transactionId'] ?? '');
$username      = trim((string) ($data['userId'] ?? ''));
$paidAmount    = (int) ($data['paidAmount'] ?? $data['finalAmount'] ?? 0);

if ($qrId === '' || $username === '' || $paidAmount <= 0) {
    fail(400, 'Data wajib tidak lengkap (qrId/userId/paidAmount)');
}

// ── 4. Kredit saldo (IDEMPOTEN) ──────────────────────────────────────────────
try {
    $result = creditUserBalance($username, $paidAmount, $qrId, $transactionId, $data);
    if ($result === 'already') {
        echo json_encode(['success' => true, 'message' => 'Sudah diproses (idempoten)']);
        exit;
    }
    echo json_encode(['success' => true, 'message' => 'Saldo dikreditkan']);
} catch (Throwable $e) {
    error_log('[QRIS deposit-callback] ' . $e->getMessage());
    fail(500, 'Gagal memproses deposit'); // 500 -> QRIS Kita akan retry
}

/**
 * ⚠️ OPERATOR: SESUAIKAN fungsi ini dengan skema database situs Anda.
 *
 * WAJIB IDEMPOTEN: bila $qrId sudah pernah diproses, JANGAN tambah saldo dua
 * kali. Kembalikan 'already' bila sudah, atau 'ok' bila baru dikredit.
 *
 * Contoh di bawah pakai PDO/MySQL — ganti kredensial, nama tabel & kolom.
 */
function creditUserBalance($username, $amount, $qrId, $transactionId, $payload) {
    $pdo = new PDO(
        'mysql:host=127.0.0.1;dbname=NAMA_DB;charset=utf8mb4',
        'DB_USER', 'DB_PASS',
        [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]
    );

    $pdo->beginTransaction();
    try {
        // 4a. Cek idempotensi. Buat sekali:
        //   CREATE TABLE qris_deposits (
        //     qr_id VARCHAR(64) PRIMARY KEY,
        //     username VARCHAR(64), amount INT,
        //     transaction_id VARCHAR(64),
        //     created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        //   );
        $chk = $pdo->prepare('SELECT 1 FROM qris_deposits WHERE qr_id = ? LIMIT 1');
        $chk->execute([$qrId]);
        if ($chk->fetchColumn()) { $pdo->rollBack(); return 'already'; }

        // 4b. Tambah saldo user (SESUAIKAN nama tabel/kolom).
        $upd = $pdo->prepare('UPDATE users SET balance = balance + ? WHERE username = ?');
        $upd->execute([$amount, $username]);
        if ($upd->rowCount() === 0) {
            throw new RuntimeException('User tidak ditemukan: ' . $username);
        }

        // 4c. Catat log deposit (kunci idempotensi).
        $ins = $pdo->prepare('INSERT INTO qris_deposits (qr_id, username, amount, transaction_id) VALUES (?, ?, ?, ?)');
        $ins->execute([$qrId, $username, $amount, $transactionId]);

        $pdo->commit();
        return 'ok';
    } catch (Throwable $e) {
        $pdo->rollBack();
        throw $e;
    }
}
