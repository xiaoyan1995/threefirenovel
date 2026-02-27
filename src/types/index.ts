export interface Project {
    id: string;
    name: string;
    genre: string;
    description: string;
    structure?: string;
    custom_structure?: string;
    chapter_words?: number;
    priority?: string;
    target_audience?: string;
    status: string;
    model_main: string;
    model_secondary: string;
    temperature: number;
    word_target: number;
    total_words?: number;
    chapter_count?: number;
    created_at?: string;
    updated_at?: string;
}

export interface Chapter {
    id: string;
    project_id: string;
    chapter_num: number;
    title: string;
    phase?: string;
    synopsis?: string;
    summary?: string;
    word_count: number;
    status: string;
    created_at?: string;
    updated_at?: string;
    paragraphs?: Paragraph[];
}

export interface Paragraph {
    id?: string;
    chapter_id?: string;
    para_index: number;
    content: string;
    ai_generated?: boolean;
}

export interface Character {
    id: string;
    project_id?: string;
    name: string;
    category: string;
    gender?: string;
    age?: string;
    identity: string;
    appearance?: string;
    personality: string;
    motivation?: string;
    backstory?: string;
    arc?: string;
    usage_notes?: string;
    relations?: CharacterRelation[];
    outgoing_relations?: CharacterRelation[];
    status?: string;
    sort_order?: number;
    created_at?: string;
    updated_at?: string;
}

export interface CharacterRelation {
    id: string;
    character_a_id: string;
    character_b_id: string;
    relation_type?: string;
    description?: string;
    name_a?: string;
    name_b?: string;
    target_name?: string;
    created_at?: string;
}

export interface OutlinePhase {
    id: string;
    project_id?: string;
    phase_name: string;
    description: string;
    order_index: number;
    created_at?: string;
    updated_at?: string;
}

export interface Foreshadow {
    id: string;
    project_id?: string;
    name: string;
    description: string;
    category: string;
    status: string;
    importance: string;
    plant_chapter_id?: string | null;
    resolve_chapter_id?: string | null;
    plant_chapter?: string | null;
    resolve_chapter?: string | null;
    plant_text?: string;
    resolve_text?: string;
    created_at?: string;
    updated_at?: string;
}

export interface WorldItem {
    id: string;
    project_id?: string;
    category: string;
    title: string;
    content: string;
    created_at?: string;
    updated_at?: string;
}

export interface EntityCandidate {
    id: string;
    project_id: string;
    chapter_id?: string | null;
    chapter_num?: number | null;
    chapter_title?: string | null;
    entity_type: "character" | "worldbuilding";
    name: string;
    category: string;
    description: string;
    gender?: string;
    age?: string;
    source_excerpt?: string;
    confidence?: number;
    status: "pending" | "approved" | "merged" | "ignored";
    target_id?: string;
    created_at?: string;
    updated_at?: string;
}

export interface ContextItem {
    label: string;
    detail: string;
}

// API Response Wrappers
export interface ApiResponse<T> {
    data: T;
    message?: string;
    error?: string;
}

export interface ChapterBeat {
    id: string;
    chapter_id: string;
    order_index: number;
    content: string;
    status: 'pending' | 'writing' | 'done';
    created_at?: string;
    updated_at?: string;
}

export interface NEREntity {
    name: string;
    category: string;
    is_known: boolean;
    description?: string;
    db_id?: string;
}

export interface NERResponse {
    entities: NEREntity[];
}

export interface ConflictItem {
    type: string;
    quote: string;
    description: string;
    suggestion: string;
}

export interface ConflictResponse {
    conflicts: ConflictItem[];
    summary: string;
}

export interface ImpactNode {
    chapter_id: string;
    chapter_num?: number | null;
    chapter_title: string;
    severity: "high" | "medium" | "low";
    reason: string;
    suggestion: string;
}

export interface ButterflyResponse {
    impacts: ImpactNode[];
    summary: string;
}
