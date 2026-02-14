import { describe, expect, it } from 'vitest';
import { assessPermissionRisk, parseControlCommand } from './permission-listener.js';

describe('parseControlCommand', () => {
    it('accepts valid skill profiles', () => {
        expect(parseControlCommand('（skill:plan）')).toEqual({ type: 'set_skill', profile: 'plan' });
        expect(parseControlCommand('(skill:debug)')).toEqual({ type: 'set_skill', profile: 'debug' });
    });

    it('rejects unknown skill profiles', () => {
        expect(parseControlCommand('（skill:foo）')).toEqual({ type: 'invalid_skill', raw: 'foo' });
    });
});

describe('assessPermissionRisk', () => {
    it('classifies shell control operators as high risk', () => {
        expect(assessPermissionRisk('echo hi; rm -rf /tmp/x')).toBe('high');
        expect(assessPermissionRisk('echo hi | wc -l')).toBe('high');
    });

    it('classifies network commands as high risk', () => {
        expect(assessPermissionRisk('curl https://example.com')).toBe('high');
        expect(assessPermissionRisk('wget https://example.com')).toBe('high');
    });

    it('keeps harmless read-only commands as low risk', () => {
        expect(assessPermissionRisk('pwd')).toBe('low');
        expect(assessPermissionRisk('ls -la')).toBe('low');
        expect(assessPermissionRisk('git status --short')).toBe('low');
    });

    it('defaults unknown commands to medium risk', () => {
        expect(assessPermissionRisk('node app.js')).toBe('medium');
    });
});
