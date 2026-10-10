import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CronJobSchema } from '../src/web/schemas.js';

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const reference = read('docs/api-reference.md');
const wiki = read('docs/wiki/HTTP-API.md');
const guide = read('docs/wiki/Cron-Jobs.md');

const cronSection = (text: string) => text.split('## Cron jobs\n')[1]?.split('\n## ')[0] ?? '';

describe('cron documentation', () => {
  it('documents every cron route in both API references', () => {
    const routes = [...read('src/web/routes/cron-routes.ts').matchAll(/app\.(get|post|put|delete)\('([^']+)'/g)];
    expect(routes).toHaveLength(9);
    for (const [, method, path] of routes) {
      const row = `| ${method.toUpperCase()} | \`${path.replace('/api/', '/api/v1/')}\` |`;
      expect(cronSection(reference)).toContain(row);
      expect(cronSection(wiki)).toContain(row);
    }
  });

  it('documents every accepted job field and validates the guide example', () => {
    for (const field of Object.keys(CronJobSchema.shape)) {
      expect(cronSection(reference)).toContain(`| \`${field}\` |`);
    }
    const example = guide.match(/-d '(\{[\s\S]*?\})'/)?.[1];
    expect(example).toBeDefined();
    expect(CronJobSchema.safeParse(JSON.parse(example!)).success).toBe(true);
  });

  it('documents all run statuses without treating prompt delivery as task success', () => {
    const statusType = read('src/types/cron.ts').match(/export type CronJobRunStatus = ([^;]+);/)?.[1];
    expect(statusType).toBeDefined();
    for (const [, status] of statusType!.matchAll(/'([^']+)'/g)) {
      expect(guide).toContain(`| \`${status}\``);
      expect(cronSection(reference)).toContain(`\`${status}\``);
    }
    expect(guide).toContain("not whether\nthe agent's task succeeded");
    expect(guide).toContain('bottom toolbar');
    expect(guide).toContain('App Settings → Header & Panels → Scheduling');
  });
});
