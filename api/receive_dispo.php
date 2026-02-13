<?php
declare(strict_types=1);

use App\Db;
use App\DispoImportService;
use App\DispoPayloadValidator;

require_once __DIR__ . '/../bootstrap.php';

header('Content-Type: application/json; charset=utf-8');

enforceApiKeyIfConfigured();

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    http_response_code(405);
    echo json_encode([
        'ok' => false,
        'error' => 'Method Not Allowed. Nur POST ist erlaubt.',
    ], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

$body = file_get_contents('php://input');
if (!is_string($body) || trim($body) === '') {
    http_response_code(400);
    echo json_encode([
        'ok' => false,
        'error' => 'Leerer Request-Body.',
    ], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

$payload = json_decode($body, true);
if (!is_array($payload)) {
    http_response_code(400);
    echo json_encode([
        'ok' => false,
        'error' => 'Ungueltiges JSON im Request-Body.',
    ], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

try {
    $validator = new DispoPayloadValidator();
    $normalized = $validator->validateAndNormalize($payload);

    $service = new DispoImportService(Db::connection());
    $result = $service->import($normalized, $payload);

    echo json_encode([
        'ok' => true,
        'batchId' => $result['batchId'],
        'processedJobs' => $result['processedJobs'],
        'processedAbsences' => $result['processedAbsences'],
        'processedAssignments' => $result['processedAssignments'],
        'idempotent' => $result['idempotent'],
    ], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
} catch (Throwable $e) {
    http_response_code(422);
    echo json_encode([
        'ok' => false,
        'error' => $e->getMessage(),
    ], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
}

function enforceApiKeyIfConfigured(): void
{
    $expectedApiKey = getenv('DISPO_API_KEY') ?: '';
    if ($expectedApiKey === '') {
        return;
    }

    $providedApiKey = extractProvidedApiKey();
    if ($providedApiKey !== $expectedApiKey) {
        http_response_code(401);
        echo json_encode([
            'ok' => false,
            'error' => 'Unauthorized. API-Key fehlt oder ist ungueltig.',
        ], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
        exit;
    }
}

function extractProvidedApiKey(): string
{
    $headerApiKey = $_SERVER['HTTP_X_API_KEY'] ?? '';
    if (is_string($headerApiKey) && trim($headerApiKey) !== '') {
        return trim($headerApiKey);
    }

    $authHeader = $_SERVER['HTTP_AUTHORIZATION'] ?? '';
    if (!is_string($authHeader)) {
        return '';
    }

    if (preg_match('/^Bearer\s+(.+)$/i', trim($authHeader), $matches) === 1) {
        return trim($matches[1]);
    }

    return '';
}
