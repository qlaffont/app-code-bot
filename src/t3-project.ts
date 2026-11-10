export interface T3Project {
    id: string;
    title: string;
}

/**
 * T3_PROJECT_ID may hold the project's id or its title: T3 answers a launch on
 * an unknown project with a generic "operation could not be completed", so the
 * bot resolves it up front and says which projects exist.
 */
export function findProject(projects: T3Project[], wanted: string): string {
    const needle = wanted.trim().toLowerCase();
    const match = projects.find((project) => project.id === wanted.trim() || project.title.toLowerCase() === needle);
    if (match) return match.id;
    const available = projects.map((project) => `${project.title} (${project.id})`).join(", ");
    throw new Error(`T3 project "${wanted.trim()}" not found. Set T3_PROJECT_ID to one of: ${available}`);
}
