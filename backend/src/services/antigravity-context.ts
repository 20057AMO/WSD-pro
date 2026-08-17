import fs from 'fs';
import path from 'path';

export interface ProjectAnalysis {
    name: string;
    framework: string;
    language: string;
    dependencies: string[];
    structure: string[];
    conventions: string[];
}

function readJsonIfExists(file: string): Record<string, unknown> | null {
    try {
        const raw = fs.readFileSync(file, 'utf8');
        return JSON.parse(raw) as Record<string, unknown>;
    } catch {
        return null;
    }
}

function safeList(dir: string): string[] {
    try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        const out = entries
            .filter((entry) => !entry.name.startsWith('.') || entry.name === '.env' || entry.name === '.env.example')
            .map((entry) => entry.name)
            .sort((a, b) => {
                const aDir = fs.existsSync(path.join(dir, a)) && fs.statSync(path.join(dir, a)).isDirectory();
                const bDir = fs.existsSync(path.join(dir, b)) && fs.statSync(path.join(dir, b)).isDirectory();
                return Number(bDir) - Number(aDir) || a.localeCompare(b);
            });
        return out.slice(0, 12);
    } catch {
        return [];
    }
}

function detectFramework(dir: string, pkg: Record<string, unknown> | null): string {
    const files = fs.readdirSync(dir, { withFileTypes: true }).map((entry) => entry.name.toLowerCase());
    if (pkg) {
        const deps = {
            ...(pkg.dependencies as Record<string, unknown> | undefined),
            ...(pkg.devDependencies as Record<string, unknown> | undefined),
        };
        if (deps.next) return 'Next.js';
        if (deps.react || deps['@preact/compat']) return 'React';
        if (deps.vite || files.includes('vite.config.ts') || files.includes('vite.config.js')) return 'Vite';
        if (deps.express) return 'Express';
        if (deps['@nestjs/core']) return 'NestJS';
        if (deps.vue) return 'Vue';
    }
    if (files.includes('docker-compose.yml') || files.includes('docker-compose.yaml')) return 'Docker Compose';
    if (files.includes('pyproject.toml') || files.includes('requirements.txt')) return 'Python';
    if (files.includes('cargo.toml')) return 'Rust';
    if (files.includes('go.mod')) return 'Go';
    if (files.includes('package.json')) return 'Node.js';
    if (files.includes('tsconfig.json')) return 'TypeScript';
    return 'Unknown';
}

function detectLanguage(dir: string, pkg: Record<string, unknown> | null): string {
    const files = fs.readdirSync(dir, { withFileTypes: true }).map((entry) => entry.name.toLowerCase());
    if (files.includes('package.json') || files.some((name) => name.endsWith('.ts') || name.endsWith('.tsx') || name.endsWith('.js') || name.endsWith('.jsx'))) {
        return 'TypeScript';
    }
    if (files.includes('requirements.txt') || files.includes('pyproject.toml') || files.some((name) => name.endsWith('.py'))) {
        return 'Python';
    }
    if (files.includes('go.mod') || files.some((name) => name.endsWith('.go'))) {
        return 'Go';
    }
    if (pkg && (pkg.dependencies || pkg.devDependencies)) {
        return 'JavaScript';
    }
    return 'Mixed';
}

function collectDependencies(pkg: Record<string, unknown> | null): string[] {
    if (!pkg) return [];
    const deps = {
        ...(pkg.dependencies as Record<string, unknown> | undefined),
        ...(pkg.devDependencies as Record<string, unknown> | undefined),
    };
    return Object.keys(deps).slice(0, 24);
}

function buildConventions(framework: string, language: string): string[] {
    const conventions = new Set<string>();
    if (framework === 'React') conventions.add('component-driven UI');
    if (framework === 'Next.js') conventions.add('app router conventions');
    if (framework === 'Express') conventions.add('middleware-based APIs');
    if (framework === 'Vite') conventions.add('vite build pipeline');
    if (framework === 'Docker Compose') conventions.add('containerized local services');
    if (language === 'TypeScript') conventions.add('strict TypeScript');
    if (language === 'Python') conventions.add('Python project structure');
    conventions.add('prefer minimal, reversible edits');
    conventions.add('keep project conventions stable');
    return Array.from(conventions).slice(0, 8);
}

export function analyzeProject(dir: string): ProjectAnalysis | null {
    if (!dir || !fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
        return null;
    }

    const packageJsonPath = path.join(dir, 'package.json');
    const pkg = fs.existsSync(packageJsonPath) ? readJsonIfExists(packageJsonPath) : null;
    const framework = detectFramework(dir, pkg);
    const language = detectLanguage(dir, pkg);

    return {
        name: path.basename(dir) || 'workspace',
        framework,
        language,
        dependencies: collectDependencies(pkg),
        structure: safeList(dir),
        conventions: buildConventions(framework, language),
    };
}

export function buildAntiGravitySystemPrompt(cwd: string): string {
    const analysis = analyzeProject(cwd);

    const lines = [
        'You are an expert software engineer working inside this project.',
        'Be surgical: prefer the smallest safe change, keep the architecture consistent, and explain your reasoning briefly.',
        'Do not make unrelated refactors, do not delete user work, and do not claim completion without checking the result.',
    ];

    if (analysis) {
        lines.push(`Project: ${analysis.name}`);
        lines.push(`Framework: ${analysis.framework}`);
        lines.push(`Language: ${analysis.language}`);
        if (analysis.dependencies.length > 0) {
            lines.push(`Dependencies: ${analysis.dependencies.join(', ')}`);
        }
        if (analysis.structure.length > 0) {
            lines.push(`Structure: ${analysis.structure.join(', ')}`);
        }
        if (analysis.conventions.length > 0) {
            lines.push(`Conventions: ${analysis.conventions.join('; ')}`);
        }
    } else {
        lines.push('Project context is unavailable; inspect the workspace before proposing changes.');
    }

    return lines.join('\n');
}
