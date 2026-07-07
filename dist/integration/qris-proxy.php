<?php
/**
 * ============================================================================
 *  QRIS KITA — Server-side proxy for e-commerce integration (PHP)
 * ============================================================================
 *
 *  KENAPA PERLU FILE INI?
 *  QRIS Kita memakai autentikasi HMAC-SHA256 (API Key + API Secret).
 *  API SECRET TIDAK BOLEH diletakkan di JavaScript browser — siapa pun bisa
 *  melihat source dan memalsukan transaksi. File PHP ini berjalan di server
 *  situs ecommerce-mu, menyimpan secret, dan menandatangani setiap request
 *  ke QRIS Kita. Frontend hanya berbicara ke file ini.
 *
 *  CARA PAKAI:
 *   1. Isi $QRIS_BASE_URL, $API_KEY, $API_SECRET di bawah (dari menu Clients
 *      di dashboard QRIS Kita — buat client baru, salin apiKey & apiSecret).
 *   2. Upload file ini ke situs ecommerce (mis. /qris-proxy.php).
 *   3. Pasang qris-embed.js di halaman deposit dan arahkan proxyUrl ke file ini.
 *
 *  ENDPOINT YANG DILAYANI (lewat query ?action=):
 *   - POST ?action=generate   body {userId, amount, ref?} -> buat QR
 *   - GET  ?action=status&qrId=... -> cek status pembayaran
 * ============================================================================
 */

// ─── KONFIGURASI — WAJIB DIISI ──────────────────────────────────────────────
$QRIS_BASE_URL = 'https://DOMAIN-QRIS-KITA-MU';        // mis. https://panel.example.com
$BASE_PATH     = '/qris';                               // APP_BASE_PATH di server QRIS Kita
$API_KEY       = 'qris_xxxxx_xxxxxxxxxxxxxxxx';          // dari dashboard > Clients
$API_SECRET    = 'ISI_API_SECRET_DI_SINI';              // JANGAN pernah taruh ini di JS!

// Batasi origin yang boleh memanggil proxy (kosongkan array = izinkan semua).
$ALLOWED_ORIGINS = [
    // 'https://tokomu.com',
];
// ────────────────────────────────────────────────────────────────────────────

// ─── CORS ───────────────────────────────────────────────────────────────────
$origin = $_SERVER['HTTP_ORIGIN'] ?? '';
if (empty($ALLOWED_ORIGINS)) {
    header('Access-Control-Allow-Origin: ' . ($origin ?: '*'));
} elseif (in_array($origin, $ALLOWED_ORIGINS, true)) {
    header('Access-Control-Allow-Origin: ' . $origin);
} else {
    http_response_code(403);
    header('Content-Type: application/json');
    echo json_encode(['success' => false, 'error' => 'Origin tidak diizinkan']);
    exit;
}
header('Access-Control-Allow-Methods: GET, POST, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type');
header('Content-Type: application/json; charset=utf-8');

if (($_SERVER['REQUEST_METHOD'] ?? 'GET') === 'OPTIONS') {
    http_response_code(204);
    exit;
}

/**
 * Kirim request bertanda-tangan HMAC ke QRIS Kita.
 * Canonical string harus SAMA PERSIS dengan src/core/hmac.ts:
 *   METHOD\nPATH\nTIMESTAMP\nNONCE\nBODY_SHA256_HEX
 */
function qrisRequest(string $method, string $path, ?array $body = null): array
{
    global $QRIS_BASE_URL, $API_KEY, $API_SECRET;

    $rawBody   = $body === null ? '' : json_encode($body, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
    $bodyHex   = hash('sha256', $rawBody);
    $timestamp = (string) time();
    $nonce     = bin2hex(random_bytes(16));

    $canonical = implode("\n", [strtoupper($method), $path, $timestamp, $nonce, $bodyHex]);
    $signature = hash_hmac('sha256', $canonical, $API_SECRET);

    $headers = [
        'X-API-Key: ' . $API_KEY,
        'X-Timestamp: ' . $timestamp,
        'X-Nonce: ' . $nonce,
        'X-Signature: ' . $signature,
        'Content-Type: application/json',
    ];

    $ch = curl_init($QRIS_BASE_URL . $path);
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_CUSTOMREQUEST  => strtoupper($method),
        CURLOPT_HTTPHEADER     => $headers,
        CURLOPT_TIMEOUT        => 20,
        CURLOPT_SSL_VERIFYPEER => true,
    ]);
    if ($method === 'POST') {
        curl_setopt($ch, CURLOPT_POSTFIELDS, $rawBody);
    }

    $response = curl_exec($ch);
    $httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    $curlErr  = curl_error($ch);
    curl_close($ch);

    if ($response === false) {
        return ['_httpCode' => 502, 'success' => false, 'error' => 'Gagal menghubungi QRIS Kita: ' . $curlErr];
    }

    $decoded = json_decode($response, true);
    if (!is_array($decoded)) {
        return ['_httpCode' => 502, 'success' => false, 'error' => 'Respons QRIS Kita tidak valid'];
    }
    $decoded['_httpCode'] = $httpCode;
    return $decoded;
}

function respond(array $payload): void
{
    $code = $payload['_httpCode'] ?? 200;
    unset($payload['_httpCode']);
    http_response_code($code);
    echo json_encode($payload);
    exit;
}

// ─── ROUTING ────────────────────────────────────────────────────────────────
$action = $_GET['action'] ?? '';

if ($action === 'generate') {
    $input = json_decode(file_get_contents('php://input'), true) ?? [];
    $userId = trim((string) ($input['userId'] ?? ''));
    $amount = (int) ($input['amount'] ?? 0);
    $ref    = isset($input['ref']) ? (string) $input['ref'] : null;

    if ($userId === '' || $amount < 1000) {
        respond(['_httpCode' => 400, 'success' => false, 'error' => 'userId wajib & amount minimal 1000']);
    }

    $body = ['userId' => $userId, 'amount' => $amount];
    if ($ref !== null && $ref !== '') {
        $body['externalReference'] = $ref;
    }

    $result = qrisRequest('POST', $BASE_PATH . '/api/v1/qris/generate', $body);
    respond($result);
}

if ($action === 'status') {
    $qrId = trim((string) ($_GET['qrId'] ?? ''));
    if ($qrId === '') {
        respond(['_httpCode' => 400, 'success' => false, 'error' => 'qrId wajib diisi']);
    }
    // Sanitasi ringan supaya tidak bisa menyuntik path.
    if (!preg_match('/^[A-Za-z0-9\-]{8,64}$/', $qrId)) {
        respond(['_httpCode' => 400, 'success' => false, 'error' => 'qrId tidak valid']);
    }

    $result = qrisRequest('GET', $BASE_PATH . '/api/v1/qris/' . rawurlencode($qrId) . '/status');
    respond($result);
}

respond(['_httpCode' => 404, 'success' => false, 'error' => 'action tidak dikenal (gunakan generate / status)']);
