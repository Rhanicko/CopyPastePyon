<?php
declare(strict_types=1);

header('Content-Type: application/json; charset=utf-8');
header('X-Content-Type-Options: nosniff');
header('Referrer-Policy: strict-origin-when-cross-origin');

$configPath = __DIR__ . '/config.php';
if (!is_file($configPath)) {
    respond(503, ['error' => 'Server setup is incomplete. Add api/config.php from config.example.php.']);
}
$config = require $configPath;
foreach (['db_host', 'db_name', 'db_user', 'db_pass', 'app_secret'] as $key) {
    if (empty($config[$key]) || str_contains((string) $config[$key], 'replace-with')) {
        respond(503, ['error' => 'Server setup is incomplete. Check api/config.php.']);
    }
}

try {
    $pdo = new PDO(
        sprintf('mysql:host=%s;dbname=%s;charset=utf8mb4', $config['db_host'], $config['db_name']),
        $config['db_user'],
        $config['db_pass'],
        [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION, PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC]
    );
    ensure_schema($pdo);
} catch (Throwable $error) {
    error_log('CopyPastePyon database connection failed: ' . $error->getMessage());
    respond(503, ['error' => 'The workspace database is temporarily unavailable.']);
}

$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
$path = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH) ?: '/';
$segments = array_values(array_filter(explode('/', trim($path, '/')), static fn ($part) => $part !== ''));
$apiOffset = array_search('api', $segments, true);
if ($apiOffset === false) respond(404, ['error' => 'API route not found.']);
$segments = array_slice($segments, $apiOffset + 1);
$body = request_body((int) ($config['max_note_size'] ?? 200000));

if ($method === 'POST' && $segments === ['workspaces']) create_workspace($pdo, $config, $body);
if ($method === 'POST' && $segments === ['workspaces', 'join']) join_workspace($pdo, $config, $body);
if ($method === 'POST' && $segments === ['format']) format_preview($config, $body);

if (($segments[0] ?? '') !== 'workspaces' || empty($segments[1])) respond(404, ['error' => 'API route not found.']);
$code = strtoupper((string) $segments[1]);
[$workspace, $session] = require_workspace($pdo, $code);
$tail = array_slice($segments, 2);

if ($method === 'GET' && $tail === []) respond(200, ['workspace' => workspace_dto($workspace), 'session' => session_dto($session)]);
if ($method === 'GET' && $tail === ['notes']) list_notes($pdo, $workspace, $_GET);
if ($method === 'POST' && $tail === ['notes']) create_note($pdo, $config, $workspace, $session, $body);
if ($method === 'PATCH' && ($tail[0] ?? '') === 'notes' && isset($tail[1])) update_note($pdo, $config, $workspace, $session, (int) $tail[1], $body);
if ($method === 'DELETE' && ($tail[0] ?? '') === 'notes' && isset($tail[1])) delete_note($pdo, $workspace, $session, (int) $tail[1]);
if ($method === 'GET' && $tail === ['users']) list_users($pdo, $workspace);
if ($method === 'DELETE' && ($tail[0] ?? '') === 'users' && isset($tail[1])) remove_user($pdo, $workspace, $session, (int) $tail[1]);
if ($method === 'POST' && $tail === ['leave']) leave_workspace($pdo, $workspace, $session);
if ($method === 'PATCH' && $tail === ['settings']) update_settings($pdo, $workspace, $session, $body);
if ($method === 'POST' && $tail === ['regenerate-code']) regenerate_code($pdo, $workspace, $session);
if ($method === 'POST' && $tail === ['close']) close_workspace($pdo, $workspace, $session);
respond(404, ['error' => 'API route not found.']);

function respond(int $status, array $data = []): never {
    http_response_code($status);
    if ($status !== 204) echo json_encode($data, JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE);
    exit;
}
function request_body(int $maxSize): array {
    if ((int) ($_SERVER['CONTENT_LENGTH'] ?? 0) > $maxSize + 10000) respond(413, ['error' => 'This request is too large.']);
    $raw = file_get_contents('php://input');
    if ($raw === false || $raw === '') return [];
    $data = json_decode($raw, true);
    if (!is_array($data)) respond(400, ['error' => 'Invalid JSON request body.']);
    return $data;
}
function ensure_schema(PDO $pdo): void {
    $pdo->exec("CREATE TABLE IF NOT EXISTS workspaces (id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, code VARCHAR(8) NOT NULL UNIQUE, permission_mode ENUM('collaborative','view_only') NOT NULL DEFAULT 'collaborative', status ENUM('active','closed','expired') NOT NULL DEFAULT 'active', created_at VARCHAR(30) NOT NULL, expires_at VARCHAR(30) NOT NULL, last_activity_at VARCHAR(30) NOT NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");
    $pdo->exec("CREATE TABLE IF NOT EXISTS sessions (id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, workspace_id BIGINT UNSIGNED NOT NULL, display_name VARCHAR(40) NOT NULL, role ENUM('host','editor','viewer') NOT NULL, connection_token VARCHAR(128) NOT NULL UNIQUE, connected_at VARCHAR(30) NOT NULL, last_seen_at VARCHAR(30) NOT NULL, revoked_at VARCHAR(30) NULL, INDEX sessions_workspace_active (workspace_id, revoked_at), CONSTRAINT sessions_workspace_fk FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");
    $pdo->exec("CREATE TABLE IF NOT EXISTS notes (id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, workspace_id BIGINT UNSIGNED NOT NULL, title VARCHAR(120) NOT NULL, language VARCHAR(20) NOT NULL, content MEDIUMTEXT NOT NULL, created_by VARCHAR(40) NOT NULL, updated_by VARCHAR(40) NOT NULL, created_at VARCHAR(30) NOT NULL, updated_at VARCHAR(30) NOT NULL, version INT UNSIGNED NOT NULL DEFAULT 1, INDEX notes_workspace_updated (workspace_id, updated_at), CONSTRAINT notes_workspace_fk FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");
    $pdo->exec('CREATE TABLE IF NOT EXISTS join_attempts (id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, ip_hash CHAR(64) NOT NULL, attempted_at VARCHAR(30) NOT NULL, INDEX join_attempts_window (ip_hash, attempted_at)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4');
}
function now(): string { return gmdate('Y-m-d\\TH:i:s\\Z'); }
function valid_languages(): array { return ['JavaScript', 'TypeScript', 'Python', 'Java', 'C', 'C++', 'C#', 'PHP', 'HTML', 'CSS', 'SQL', 'JSON', 'Bash', 'Markdown']; }
function clean_name(mixed $name): string { $value = trim(str_replace(['<', '>'], '', (string) $name)); return mb_substr($value, 0, 40) ?: 'Guest-' . random_int(1000, 9999); }
function workspace_code(): string { $alphabet = 'ABCDEFGHJKLMNPQRTUVWXYZ2346789'; $code = ''; for ($i = 0; $i < 8; $i++) $code .= $alphabet[random_int(0, strlen($alphabet) - 1)]; return $code; }
function token(): string { return bin2hex(random_bytes(32)); }
function workspace_dto(array $row): array { return ['code' => $row['code'], 'permissionMode' => $row['permission_mode'], 'status' => $row['status'], 'createdAt' => $row['created_at'], 'expiresAt' => $row['expires_at']]; }
function session_dto(array $row): array { return ['token' => $row['connection_token'], 'displayName' => $row['display_name'], 'role' => $row['role']]; }
function note_dto(array $row): array { return ['id' => (int) $row['id'], 'title' => $row['title'], 'language' => $row['language'], 'content' => $row['content'], 'createdBy' => $row['created_by'], 'updatedBy' => $row['updated_by'], 'createdAt' => $row['created_at'], 'updatedAt' => $row['updated_at'], 'version' => (int) $row['version']]; }
function touch_workspace(PDO $pdo, int $workspaceId): void { $pdo->prepare('UPDATE workspaces SET last_activity_at = ? WHERE id = ?')->execute([now(), $workspaceId]); }
function require_workspace(PDO $pdo, string $code): array {
    if (!preg_match('/^[A-Z0-9]{8}$/', $code)) respond(404, ['error' => 'Workspace not found. Please check the code and try again.']);
    $statement = $pdo->prepare('SELECT * FROM workspaces WHERE code = ?'); $statement->execute([$code]); $workspace = $statement->fetch();
    if (!$workspace) respond(404, ['error' => 'Workspace not found. Please check the code and try again.']);
    if ($workspace['status'] !== 'active') respond(410, ['error' => 'This workspace has been closed by the host.']);
    if (strtotime($workspace['expires_at']) <= time()) { $pdo->prepare("UPDATE workspaces SET status = 'expired' WHERE id = ?")->execute([$workspace['id']]); respond(410, ['error' => 'This workspace has expired.']); }
    $value = $_SERVER['HTTP_X_SESSION_TOKEN'] ?? '';
    if (!is_string($value) || !preg_match('/^[a-f0-9]{64}$/', $value)) respond(401, ['error' => 'A valid workspace session is required.']);
    $statement = $pdo->prepare('SELECT * FROM sessions WHERE connection_token = ? AND workspace_id = ? AND revoked_at IS NULL'); $statement->execute([$value, $workspace['id']]); $session = $statement->fetch();
    if (!$session) respond(401, ['error' => 'A valid workspace session is required.']);
    $pdo->prepare('UPDATE sessions SET last_seen_at = ? WHERE id = ?')->execute([now(), $session['id']]);
    return [$workspace, $session];
}
function rate_limit_join(PDO $pdo, array $config): void {
    $limit = max(1, (int) ($config['join_rate_limit'] ?? 30)); $cutoff = gmdate('Y-m-d\\TH:i:s\\Z', time() - 900);
    $ip = $_SERVER['REMOTE_ADDR'] ?? 'unknown'; $hash = hash_hmac('sha256', $ip, (string) $config['app_secret']);
    $pdo->prepare('DELETE FROM join_attempts WHERE attempted_at < ?')->execute([$cutoff]);
    $statement = $pdo->prepare('SELECT COUNT(*) FROM join_attempts WHERE ip_hash = ? AND attempted_at >= ?'); $statement->execute([$hash, $cutoff]);
    if ((int) $statement->fetchColumn() >= $limit) respond(429, ['error' => 'Too many connection attempts. Please try again later.']);
    $pdo->prepare('INSERT INTO join_attempts (ip_hash, attempted_at) VALUES (?, ?)')->execute([$hash, now()]);
}
function create_workspace(PDO $pdo, array $config, array $body): never {
    $mode = ($body['permissionMode'] ?? '') === 'view_only' ? 'view_only' : 'collaborative'; $hours = max(1, min((int) ($config['workspace_expiration_hours'] ?? 24), 168));
    do { $code = workspace_code(); $statement = $pdo->prepare('SELECT 1 FROM workspaces WHERE code = ?'); $statement->execute([$code]); } while ($statement->fetchColumn());
    $created = now(); $expires = gmdate('Y-m-d\\TH:i:s\\Z', time() + $hours * 3600);
    $pdo->prepare('INSERT INTO workspaces (code, permission_mode, status, created_at, expires_at, last_activity_at) VALUES (?, ?, ?, ?, ?, ?)')->execute([$code, $mode, 'active', $created, $expires, $created]);
    $workspaceId = (int) $pdo->lastInsertId(); $sessionToken = token(); $name = clean_name($body['displayName'] ?? 'Host');
    $pdo->prepare('INSERT INTO sessions (workspace_id, display_name, role, connection_token, connected_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)')->execute([$workspaceId, $name, 'host', $sessionToken, $created, $created]);
    respond(201, ['workspace' => ['code' => $code, 'permissionMode' => $mode, 'status' => 'active', 'createdAt' => $created, 'expiresAt' => $expires], 'session' => ['token' => $sessionToken, 'displayName' => $name, 'role' => 'host']]);
}
function join_workspace(PDO $pdo, array $config, array $body): never {
    rate_limit_join($pdo, $config); $code = strtoupper(trim((string) ($body['code'] ?? '')));
    if (!preg_match('/^[A-Z0-9]{8}$/', $code)) respond(404, ['error' => 'Workspace not found. Please check the code and try again.']);
    $statement = $pdo->prepare('SELECT * FROM workspaces WHERE code = ?'); $statement->execute([$code]); $workspace = $statement->fetch();
    if (!$workspace) respond(404, ['error' => 'Workspace not found. Please check the code and try again.']);
    if ($workspace['status'] !== 'active') respond(410, ['error' => 'This workspace has been closed by the host.']);
    if (strtotime($workspace['expires_at']) <= time()) { $pdo->prepare("UPDATE workspaces SET status = 'expired' WHERE id = ?")->execute([$workspace['id']]); respond(410, ['error' => 'This workspace has expired.']); }
    $created = now(); $name = clean_name($body['displayName'] ?? ''); $role = $workspace['permission_mode'] === 'view_only' ? 'viewer' : 'editor'; $sessionToken = token();
    $pdo->prepare('INSERT INTO sessions (workspace_id, display_name, role, connection_token, connected_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)')->execute([$workspace['id'], $name, $role, $sessionToken, $created, $created]); touch_workspace($pdo, (int) $workspace['id']);
    respond(200, ['workspace' => workspace_dto($workspace), 'session' => ['token' => $sessionToken, 'displayName' => $name, 'role' => $role]]);
}
function can_edit(array $session): bool { return in_array($session['role'], ['host', 'editor'], true); }
function format_preview(array $config, array $body): never {
    $language = (string) ($body['language'] ?? ''); $content = (string) ($body['content'] ?? '');
    if (!in_array($language, valid_languages(), true)) respond(422, ['error' => 'Please choose a supported language.']);
    if (strlen($content) > (int) ($config['max_note_size'] ?? 200000)) respond(413, ['error' => 'This note is larger than the configured limit.']);
    // InfinityFree has no Node formatter runtime. Preserve the submitted code rather
    // than risk changing its behavior; formatting remains available on Node hosting.
    respond(200, ['content' => $content, 'formattingAvailable' => false]);
}
function list_notes(PDO $pdo, array $workspace, array $query): never {
    $sort = $query['sort'] ?? 'updated'; $order = ['updated' => 'updated_at DESC', 'created' => 'created_at DESC', 'title' => 'title ASC', 'language' => 'language ASC'][$sort] ?? 'updated_at DESC'; $search = trim((string) ($query['search'] ?? ''));
    if ($search !== '') { $like = '%' . $search . '%'; $statement = $pdo->prepare("SELECT * FROM notes WHERE workspace_id = ? AND (title LIKE ? OR language LIKE ? OR content LIKE ?) ORDER BY $order"); $statement->execute([$workspace['id'], $like, $like, $like]); } else { $statement = $pdo->prepare("SELECT * FROM notes WHERE workspace_id = ? ORDER BY $order"); $statement->execute([$workspace['id']]); }
    respond(200, ['notes' => array_map('note_dto', $statement->fetchAll())]);
}
function create_note(PDO $pdo, array $config, array $workspace, array $session, array $body): never {
    if (!can_edit($session)) respond(403, ['error' => 'You do not have permission to perform this action.']); $title = mb_substr(trim((string) ($body['title'] ?? '')), 0, 120); $language = (string) ($body['language'] ?? 'JavaScript'); $content = (string) ($body['content'] ?? '');
    if ($title === '') respond(422, ['error' => 'A note title is required.']); if (!in_array($language, valid_languages(), true)) respond(422, ['error' => 'Please choose a supported language.']); if (strlen($content) > (int) ($config['max_note_size'] ?? 200000)) respond(413, ['error' => 'This note is larger than the configured limit.']);
    $stamp = now(); $pdo->prepare('INSERT INTO notes (workspace_id, title, language, content, created_by, updated_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')->execute([$workspace['id'], $title, $language, $content, $session['display_name'], $session['display_name'], $stamp, $stamp]); touch_workspace($pdo, (int) $workspace['id']);
    $statement = $pdo->prepare('SELECT * FROM notes WHERE id = ?'); $statement->execute([(int) $pdo->lastInsertId()]); respond(201, ['note' => note_dto($statement->fetch())]);
}
function update_note(PDO $pdo, array $config, array $workspace, array $session, int $noteId, array $body): never {
    if (!can_edit($session)) respond(403, ['error' => 'You do not have permission to perform this action.']); $statement = $pdo->prepare('SELECT * FROM notes WHERE id = ? AND workspace_id = ?'); $statement->execute([$noteId, $workspace['id']]); $note = $statement->fetch(); if (!$note) respond(404, ['error' => 'Note not found.']);
    if ((int) ($body['version'] ?? 0) !== (int) $note['version']) respond(409, ['error' => 'This note was changed by another user. Reload the latest version before saving.', 'note' => note_dto($note)]);
    $title = mb_substr(trim((string) ($body['title'] ?? $note['title'])), 0, 120); $language = (string) ($body['language'] ?? $note['language']); $content = (string) ($body['content'] ?? $note['content']);
    if ($title === '' || !in_array($language, valid_languages(), true)) respond(422, ['error' => 'Enter a title and supported language.']); if (strlen($content) > (int) ($config['max_note_size'] ?? 200000)) respond(413, ['error' => 'This note is larger than the configured limit.']);
    $pdo->prepare('UPDATE notes SET title = ?, language = ?, content = ?, updated_by = ?, updated_at = ?, version = version + 1 WHERE id = ?')->execute([$title, $language, $content, $session['display_name'], now(), $noteId]); touch_workspace($pdo, (int) $workspace['id']); $statement->execute([$noteId, $workspace['id']]); respond(200, ['note' => note_dto($statement->fetch())]);
}
function delete_note(PDO $pdo, array $workspace, array $session, int $noteId): never { if (!can_edit($session)) respond(403, ['error' => 'You do not have permission to perform this action.']); $statement = $pdo->prepare('DELETE FROM notes WHERE id = ? AND workspace_id = ?'); $statement->execute([$noteId, $workspace['id']]); if ($statement->rowCount() === 0) respond(404, ['error' => 'Note not found.']); touch_workspace($pdo, (int) $workspace['id']); respond(204); }
function list_users(PDO $pdo, array $workspace): never { $activeSince = gmdate('Y-m-d\\TH:i:s\\Z', time() - 90); $statement = $pdo->prepare("SELECT id, display_name, role, last_seen_at FROM sessions WHERE workspace_id = ? AND revoked_at IS NULL ORDER BY role = 'host' DESC, connected_at"); $statement->execute([$workspace['id']]); $users = array_map(static fn ($user) => ['id' => (int) $user['id'], 'displayName' => $user['display_name'], 'role' => $user['role'], 'online' => $user['last_seen_at'] >= $activeSince], $statement->fetchAll()); respond(200, ['users' => $users]); }
function remove_user(PDO $pdo, array $workspace, array $session, int $sessionId): never { if ($session['role'] !== 'host') respond(403, ['error' => 'Only the host can remove participants.']); $statement = $pdo->prepare("UPDATE sessions SET revoked_at = ? WHERE id = ? AND workspace_id = ? AND role != 'host' AND revoked_at IS NULL"); $statement->execute([now(), $sessionId, $workspace['id']]); if ($statement->rowCount() === 0) respond(404, ['error' => 'Participant not found.']); respond(204); }
function leave_workspace(PDO $pdo, array $workspace, array $session): never { if ($session['role'] === 'host') respond(422, ['error' => 'The host can end sharing instead.']); $pdo->prepare('UPDATE sessions SET revoked_at = ? WHERE id = ?')->execute([now(), $session['id']]); respond(204); }
function update_settings(PDO $pdo, array $workspace, array $session, array $body): never { if ($session['role'] !== 'host') respond(403, ['error' => 'Only the host can change workspace settings.']); $mode = $body['permissionMode'] ?? ''; if (!in_array($mode, ['collaborative', 'view_only'], true)) respond(422, ['error' => 'Invalid permission setting.']); $pdo->prepare('UPDATE workspaces SET permission_mode = ?, last_activity_at = ? WHERE id = ?')->execute([$mode, now(), $workspace['id']]); $pdo->prepare("UPDATE sessions SET role = ? WHERE workspace_id = ? AND role != 'host'")->execute([$mode === 'view_only' ? 'viewer' : 'editor', $workspace['id']]); $workspace['permission_mode'] = $mode; respond(200, ['workspace' => workspace_dto($workspace)]); }
function regenerate_code(PDO $pdo, array $workspace, array $session): never { if ($session['role'] !== 'host') respond(403, ['error' => 'Only the host can regenerate the workspace code.']); do { $code = workspace_code(); $statement = $pdo->prepare('SELECT 1 FROM workspaces WHERE code = ?'); $statement->execute([$code]); } while ($statement->fetchColumn()); $pdo->prepare('UPDATE workspaces SET code = ?, last_activity_at = ? WHERE id = ?')->execute([$code, now(), $workspace['id']]); $workspace['code'] = $code; respond(200, ['workspace' => workspace_dto($workspace)]); }
function close_workspace(PDO $pdo, array $workspace, array $session): never { if ($session['role'] !== 'host') respond(403, ['error' => 'Only the host can close the workspace.']); $pdo->prepare("UPDATE workspaces SET status = 'closed' WHERE id = ?")->execute([$workspace['id']]); respond(204); }
