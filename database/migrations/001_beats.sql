CREATE TABLE IF NOT EXISTS chapter_beats (
    id          TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    chapter_id  TEXT NOT NULL,
    order_index INTEGER DEFAULT 0,
    content     TEXT NOT NULL,
    status      TEXT DEFAULT 'pending',
    created_at  TEXT DEFAULT (datetime('now')),
    updated_at  TEXT DEFAULT (datetime('now')),
    FOREIGN KEY(chapter_id) REFERENCES chapters(id) ON DELETE CASCADE
);
