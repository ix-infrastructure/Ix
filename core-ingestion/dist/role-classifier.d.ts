export type EntityRole = 'production' | 'test' | 'fixture' | 'generated' | 'external' | 'tooling';
export interface RoleClassification {
    role: EntityRole;
    role_confidence: number;
    role_signals: string[];
}
export declare function classifyFileRole(filePath: string, source?: string): RoleClassification;
