<?php
declare(strict_types=1);

use App\Db;
use App\DispoRepository;

require_once __DIR__ . '/../bootstrap.php';

header('Content-Type: application/json; charset=utf-8');

$raw = trim((string) ($_GET['fabs'] ?? ''));
if ($raw === '') {
    echo json_encode(['ok' => true, 'data' => []], JSON_UNESCAPED_UNICODE);
    exit;
}
$fabs = array_values(array_unique(array_filter(array_map('trim', explode(',', $raw)))));
$repo = new DispoRepository(Db::fsm());
$data = $repo->getAnlagenstammByFabrikationsnummern($fabs);
echo json_encode(['ok' => true, 'data' => $data], JSON_UNESCAPED_UNICODE);
