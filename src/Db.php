<?php
declare(strict_types=1);

namespace App;

use PDO;

final class Db
{
    /** Verbindung zur eigenen Monteur-WebApp-DB (z. B. Batches, Audit). */
    public static function connection(): PDO
    {
        $host = getenv('DB_HOST') ?: '127.0.0.1';
        $port = getenv('DB_PORT') ?: '3306';
        $dbName = getenv('DB_NAME') ?: 'monteur_webapp';
        $user = getenv('DB_USER') ?: 'root';
        $password = getenv('DB_PASSWORD') ?: '';

        $dsn = sprintf('mysql:host=%s;port=%s;dbname=%s;charset=utf8mb4', $host, $port, $dbName);

        return new PDO($dsn, $user, $password, [
            PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
            PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
            PDO::ATTR_EMULATE_PREPARES => false,
        ]);
    }

    /** Verbindung zur Dispo-DB (fsm) – Lesen und Schreiben nach Bedarf. */
    public static function fsm(): PDO
    {
        $host = getenv('FSM_DB_HOST') ?: getenv('DB_HOST') ?: '127.0.0.1';
        $port = getenv('FSM_DB_PORT') ?: getenv('DB_PORT') ?: '3306';
        $dbName = getenv('FSM_DB_NAME') ?: 'fsm';
        $user = getenv('FSM_DB_USER') ?: getenv('DB_USER') ?: 'root';
        $password = getenv('FSM_DB_PASSWORD') ?: getenv('DB_PASSWORD') ?: '';

        $dsn = sprintf('mysql:host=%s;port=%s;dbname=%s;charset=utf8mb4', $host, $port, $dbName);

        return new PDO($dsn, $user, $password, [
            PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
            PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
            PDO::ATTR_EMULATE_PREPARES => false,
        ]);
    }
}
