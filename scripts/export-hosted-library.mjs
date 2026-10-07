// Read-only export: database credentials stay on the developer machine.
import { createRequire } from 'node:module';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
const web = resolve(process.argv[2] || `${homedir()}/Sites/taste-web`);
const library = resolve(process.argv[3] || `${homedir()}/Sites/taste/library`);
process.loadEnvFile(resolve(web, '.env.local'));
const require = createRequire(resolve(web, 'package.json'));
const { neon } = require('@neondatabase/serverless');
const sql = neon(process.env.DATABASE_URL);
const rows = await sql`SELECT file, url FROM "references" WHERE url IS NOT NULL`;
const urls = new Map(rows.map(r => [r.file, r.url]));
const refs = JSON.parse(await readFile(resolve(library, 'references.json')));
const embeddings = JSON.parse(await readFile(resolve(library, 'embeddings.json')));
const hosted = refs.filter(r => embeddings[r.file] && urls.has(r.file)).map(r => {
  const url = new URL(urls.get(r.file));
  if (url.protocol !== 'https:' || !url.hostname.endsWith('.public.blob.vercel-storage.com')) throw new Error('Unexpected image host');
  return {...r, url: url.href};
});
if (!hosted.length) throw new Error('No hosted references matched the CLIP index');
await mkdir('deploy-data', {recursive:true});
await writeFile('deploy-data/references.json', JSON.stringify(hosted));
await writeFile('deploy-data/embeddings.json', JSON.stringify(Object.fromEntries(hosted.map(r=>[r.file,embeddings[r.file]]))));
console.log(`Exported ${hosted.length} hosted references; ${refs.filter(r=>embeddings[r.file]).length-hosted.length} indexed references lack hosted URLs.`);
