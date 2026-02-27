ALTER TABLE projects ADD COLUMN structure TEXT DEFAULT '起承转合';
ALTER TABLE projects ADD COLUMN custom_structure TEXT DEFAULT '';
ALTER TABLE projects ADD COLUMN chapter_words INTEGER DEFAULT 5000;
ALTER TABLE projects ADD COLUMN priority TEXT DEFAULT '品质优先';

UPDATE projects
SET structure = '起承转合'
WHERE structure IS NULL OR TRIM(structure) = '';

UPDATE projects
SET custom_structure = ''
WHERE custom_structure IS NULL;

UPDATE projects
SET chapter_words = 5000
WHERE chapter_words IS NULL OR chapter_words <= 0;

UPDATE projects
SET priority = '品质优先'
WHERE priority IS NULL OR TRIM(priority) = '';
