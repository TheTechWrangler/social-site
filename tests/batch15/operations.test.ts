import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import Database from 'better-sqlite3';
import jwt from 'jsonwebtoken';
import { applyMigration } from '../../server/migrations.js';
import { createRecoverySet, restoreRecoverySet, verifyRecoverySet, RECOVERY_LIMITS } from '../../server/recovery.js';
import { acquireStorageLease } from '../../server/storageSafety.js';
import { reclaimManagedAssets } from '../../server/assetLifecycle.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'refugecloud-batch15-'));
process.env.NODE_ENV = 'test'; process.env.DOTENV_CONFIG_PATH = '/dev/null';
process.env.DATABASE_PATH = path.join(root, 'bootstrap.db'); process.env.UPLOADS_DIR = path.join(root, 'bootstrap-uploads');
let initialize: (db?: Database.Database) => void, bootstrap: Database.Database;
before(async () => { const module = await import('../../server/database.js'); initialize = module.initializeDatabase; bootstrap = module.getDb(); });
after(() => { bootstrap?.close(); fs.rmSync(root, { recursive: true, force: true }); });
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aLz8AAAAASUVORK5CYII=', 'base64');
function fixture() {
  const folder = fs.mkdtempSync(path.join(root, 'case-'));
  const storage = { databasePath: path.join(folder, 'database.sqlite'), uploadsDir: path.join(folder, 'uploads'), backupRoot: path.join(folder, 'backups') };
  fs.mkdirSync(storage.uploadsDir); fs.mkdirSync(storage.backupRoot);
  const db = new Database(storage.databasePath); db.pragma('foreign_keys = ON'); db.pragma('journal_mode = WAL'); initialize(db);
  db.exec("INSERT INTO users(id,username,display_name,email,password_hash,is_verified) VALUES (1,'author','Author','author@test.invalid','test',1), (2,'other','Other','other@test.invalid','test',1)");
  db.exec("INSERT INTO posts(id,user_id,content) VALUES (1,1,'snapshot content')");
  return { ...storage, db };
}
function asset(f: ReturnType<typeof fixture>, state = 'active') {
  const id = 'a'.repeat(32), name = `asset-${id}.png`;
  fs.writeFileSync(path.join(f.uploadsDir, name), png);
  f.db.prepare(`INSERT INTO managed_assets(id,owner_user_id,storage_key,url,media_type,mime_type,file_size_bytes,sha256,purpose,state,created_at_ms,reclaim_after_ms)
    VALUES (?,1,?,?,'image','image/png',?,?,'post_image',?,0,0)`).run(id,name,`/uploads/${name}`,png.length,createHash('sha256').update(png).digest('hex'),state);
  if (state === 'active') f.db.prepare("INSERT INTO post_media(post_id,asset_id,media_type,url,alt_text) VALUES (1,?,'image',?,'Persisted description')").run(id,`/uploads/${name}`);
  return { id, name, filename: path.join(f.uploadsDir, name) };
}

test('migration ledger is transactional, repeat-safe and never records failed work', () => {
  const db = new Database(':memory:');
  assert.throws(() => applyMigration(db,'failure',() => { db.exec('CREATE TABLE partial(id)'); throw Error('injected'); }), /injected/);
  assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE name IN ('partial','schema_migrations')").get(), undefined);
  let calls=0; for(let i=0;i<3;i++) applyMigration(db,'success',() => {calls++;db.exec('CREATE TABLE complete(id)');});
  assert.equal(calls,1); assert.equal((db.prepare('SELECT COUNT(*) n FROM schema_migrations').get() as any).n,1); db.close();
});
test('representative old schema migrates, preserves accepted edges and text, and restarts twice', () => {
  const f=fixture(); f.db.exec("INSERT INTO follows(follower_id,following_id) VALUES (1,2)");
  f.db.exec(`DROP INDEX idx_follows_following_status; DROP INDEX idx_follows_follower_status;
    ALTER TABLE follows DROP COLUMN status; ALTER TABLE posts DROP COLUMN edited_at; ALTER TABLE posts DROP COLUMN edit_version;
    ALTER TABLE rss_sources DROP COLUMN last_fetch_error; ALTER TABLE rss_sources DROP COLUMN last_fetch_attempt_at;`);
  initialize(f.db); const first = f.db.prepare('SELECT * FROM schema_migrations ORDER BY id').all();
  initialize(f.db); initialize(f.db); assert.deepEqual(f.db.prepare('SELECT * FROM schema_migrations ORDER BY id').all(),first);
  assert.equal((f.db.prepare('SELECT status FROM follows').get() as any).status,'accepted');
  assert.deepEqual(f.db.prepare('SELECT content,edited_at,edit_version FROM posts').get(), {content:'snapshot content',edited_at:null,edit_version:0}); f.db.close();
});
test('startup invalid precondition rolls back earlier ALTER and migration ledger work', () => {
  const f=fixture(); f.db.exec("ALTER TABLE posts DROP COLUMN edited_at; INSERT INTO follows(follower_id,following_id) VALUES (1,1)");
  const ledger=f.db.prepare('SELECT * FROM schema_migrations').all();
  assert.throws(()=>initialize(f.db),/self_edges/);
  assert.equal((f.db.pragma('table_info(posts)') as any[]).some(c=>c.name==='edited_at'),false);
  assert.deepEqual(f.db.prepare('SELECT * FROM schema_migrations').all(),ledger); f.db.close();
});
test('migration refuses ambiguous authored duplicate reposts without deleting evidence',()=>{
  const f=fixture();
  f.db.exec("DELETE FROM schema_migrations WHERE id='010-notification-invariants'; DROP INDEX idx_posts_user_repost_unique; INSERT INTO posts(user_id,content,repost_of) VALUES (2,'',1),(2,'authored evidence',1)");
  const before=f.db.prepare('SELECT * FROM posts').all();assert.throws(()=>initialize(f.db),/authored data/);
  assert.deepEqual(f.db.prepare('SELECT * FROM posts').all(),before);
  assert.equal(f.db.prepare("SELECT 1 FROM schema_migrations WHERE id='010-notification-invariants'").get(),undefined);f.db.close();
});

test('RSS item and success metadata writes roll back together, then idempotently retry',async()=>{
  const {persistFetchedFeed}=await import('../../server/rssService.js');
  const f=fixture();f.db.exec("INSERT INTO rss_sources(id,name,url) VALUES (1,'Fixture','https://feed.example.test/rss')");
  const source=f.db.prepare('SELECT * FROM rss_sources WHERE id=1').get() as any;
  const feed={items:[{guid:'one',title:'good',link:'https://feed.example.test/1'},{guid:'two',title:'bad',link:'https://feed.example.test/2'}]};
  f.db.exec("CREATE TRIGGER fail_rss BEFORE INSERT ON rss_items WHEN NEW.title='bad' BEGIN SELECT RAISE(ABORT,'injected'); END");
  assert.throws(()=>persistFetchedFeed(f.db,source,feed),/injected/);
  assert.equal((f.db.prepare('SELECT COUNT(*) n FROM rss_items').get() as any).n,0);
  assert.equal((f.db.prepare('SELECT last_fetched_at FROM rss_sources').get() as any).last_fetched_at,null);
  f.db.exec('DROP TRIGGER fail_rss');assert.equal(persistFetchedFeed(f.db,source,feed).inserted,2);assert.equal(persistFetchedFeed(f.db,source,feed).dupes,2);f.db.close();
});

test('WAL snapshot, upload inventory, manifest and stable checksums form one recovery point', () => {
  const f=fixture(), a=asset(f); fs.writeFileSync(path.join(f.uploadsDir,'legacy.png'),png);
  f.db.exec("INSERT INTO sessions(sid,sess,expire) VALUES ('old-session','{}',9999999999)");
  assert.ok(fs.statSync(f.databasePath+'-wal').size>0);
  const id=createRecoverySet(f), manifest=verifyRecoverySet(f.backupRoot,id);
  assert.equal(manifest.uploads.length,2); assert.ok(manifest.uploads.some(e=>e.name===a.name));
  const snapshot=new Database(path.join(f.backupRoot,id,'database.sqlite'),{readonly:true});
  assert.equal((snapshot.prepare('SELECT content FROM posts').get() as any).content,'snapshot content');
  assert.equal((snapshot.prepare('SELECT COUNT(*) n FROM sessions').get() as any).n,1); snapshot.close();f.db.close();
});
test('injected backup failure leaves only staging, and exclusive lease prevents overlap', () => {
  const f=fixture();asset(f);
  assert.throws(()=>createRecoverySet(f,{checkpoint:step=>{if(step==='before-complete')throw Error('copy failed');}}),/copy failed/);
  const folders=fs.readdirSync(f.backupRoot);assert.equal(folders.length,1);assert.match(folders[0],/^\.staging-/);
  assert.throws(()=>verifyRecoverySet(f.backupRoot,folders[0]),/Invalid recovery set/);
  const release=acquireStorageLease(f.databasePath);assert.throws(()=>createRecoverySet(f),/EEXIST/);release();
  assert.equal((f.db.prepare("SELECT COUNT(*) n FROM operational_audit WHERE event_type='backup.failed'").get() as any).n,1);f.db.close();
});

for(const corruption of ['missing-db','missing-upload','checksum','truncated-db','bad-json','version','traversal','symlink','incomplete'] as const) {
  test(`restore refuses ${corruption} without modifying active data/uploads`,()=>{
    const f=fixture(),a=asset(f),id=createRecoverySet(f),folder=path.join(f.backupRoot,id),filename=path.join(folder,'manifest.json');
    const manifest=JSON.parse(fs.readFileSync(filename,'utf8'));
    if(corruption==='missing-db')fs.unlinkSync(path.join(folder,'database.sqlite'));
    if(corruption==='missing-upload')fs.unlinkSync(path.join(folder,'uploads',a.name));
    if(corruption==='checksum')fs.writeFileSync(path.join(folder,'uploads',a.name),'changed');
    if(corruption==='truncated-db')fs.truncateSync(path.join(folder,'database.sqlite'),100);
    if(corruption==='bad-json')fs.writeFileSync(filename,'{');
    if(corruption==='version'){manifest.format=999;fs.writeFileSync(filename,JSON.stringify(manifest));}
    if(corruption==='traversal'){manifest.uploads[0].name='../outside';fs.writeFileSync(filename,JSON.stringify(manifest));}
    if(corruption==='symlink'){fs.unlinkSync(path.join(folder,'uploads',a.name));fs.symlinkSync(a.filename,path.join(folder,'uploads',a.name));}
    if(corruption==='incomplete'){manifest.complete=false;fs.writeFileSync(filename,JSON.stringify(manifest));}
    f.db.exec("UPDATE posts SET content='current content'");f.db.close();
    const before=fs.readFileSync(f.databasePath),image=fs.readFileSync(a.filename);
    assert.throws(()=>restoreRecoverySet(f,id));assert.deepEqual(fs.readFileSync(f.databasePath),before);assert.deepEqual(fs.readFileSync(a.filename),image);
  });
}
test('backup refuses symlink, referenced missing media and overlapping storage roots',()=>{
  const f=fixture(),a=asset(f);fs.unlinkSync(a.filename);assert.throws(()=>createRecoverySet(f),/missing referenced/);
  fs.symlinkSync(path.join(root,'bootstrap.db'),a.filename);assert.throws(()=>createRecoverySet(f),/Unsupported upload/);
  assert.throws(()=>createRecoverySet({...f,backupRoot:f.uploadsDir}),/overlap/);f.db.close();
});
test('backup root is bounded without pruning the only known-good set',()=>{
  const f=fixture(),id=createRecoverySet(f);
  for(let i=1;i<RECOVERY_LIMITS.sets;i++)fs.mkdirSync(path.join(f.backupRoot,`.failed-${i}`));
  assert.throws(()=>createRecoverySet(f),/full/);verifyRecoverySet(f.backupRoot,id);f.db.close();
});
test('restore verification and rename failures leave current relational and upload state intact',()=>{
  for(const failStep of ['staged','rename-2','rename-4']) {
    const f=fixture(),a=asset(f),id=createRecoverySet(f);
    f.db.exec("UPDATE posts SET content='current'; UPDATE post_media SET alt_text='current description'");f.db.close();
    assert.throws(()=>restoreRecoverySet(f,id,{checkpoint:step=>{if(step===failStep)throw Error('injected restore');}}),/injected restore/);
    const db=new Database(f.databasePath);assert.equal((db.prepare('SELECT content FROM posts').get() as any).content,'current');db.close();
    assert.deepEqual(fs.readFileSync(a.filename),png);assert.equal(fs.existsSync(f.databasePath+'.operation-lock'),false);
  }
});

test('full restore drill restores deleted files and records; restarted application serves restored post/media and rejects old sessions', async()=>{
  const f=fixture(),a=asset(f);f.db.exec("INSERT INTO sessions(sid,sess,expire) VALUES ('historic','{}',9999999999)");
  const id=createRecoverySet(f);f.db.exec("DELETE FROM posts; UPDATE users SET display_name='changed'");f.db.close();fs.unlinkSync(a.filename);
  // The current recovery point must itself be coherent: deleted post leaves reclaimable media, not an active missing reference.
  const result=restoreRecoverySet(f,id);verifyRecoverySet(f.backupRoot,result.recoveryPoint);
  const db=new Database(f.databasePath);
  assert.equal((db.prepare('SELECT content FROM posts').get() as any).content,'snapshot content');
  assert.equal((db.prepare('SELECT COUNT(*) n FROM sessions').get() as any).n,0);
  assert.equal((db.prepare('SELECT alt_text FROM post_media').get() as any).alt_text,'Persisted description');
  assert.ok((db.prepare('SELECT auth_version FROM users WHERE id=1').get() as any).auth_version>100000);db.close();
  assert.deepEqual(fs.readFileSync(a.filename),png);
  const port=34000+Math.floor(Math.random()*10000),origin=`http://127.0.0.1:${port}`;
  const child=spawn(path.resolve('node_modules/.bin/tsx'),['server/index.ts'],{env:{...process.env,NODE_ENV:'test',DATABASE_PATH:f.databasePath,UPLOADS_DIR:f.uploadsDir,PORT:String(port),JWT_SECRET:'batch15-isolated-test',SESSION_SECRET:'batch15-isolated-session',APP_BASE_URL:origin,WEB_BASE_URL:origin,GOOGLE_CLIENT_ID:'',STEAM_API_KEY:'',RESEND_API_KEY:'',RATE_LIMIT_ENABLED:'false'},stdio:'pipe'});
  let logs='';child.stdout?.on('data',chunk=>logs+=chunk);child.stderr?.on('data',chunk=>logs+=chunk);
  try {
    let healthy=false;for(let i=0;i<100;i++){try{healthy=(await fetch(origin+'/api/health')).ok;}catch{}if(healthy)break;await new Promise(r=>setTimeout(r,50));}
    assert.ok(healthy,logs);
    const post=await fetch(origin+'/api/posts/1');assert.equal(post.status,200);assert.equal((await post.json()).post.content,'snapshot content');
    const historic=jwt.sign({id:1,username:'author',role:'user',is_verified:1},'batch15-isolated-test',{expiresIn:'10m'});
    assert.equal((await fetch(origin+'/api/notifications',{headers:{cookie:`refugecloud_auth=${historic}`}})).status,401);
    const image=await fetch(origin+`/uploads/${a.name}`);assert.equal(image.status,200);assert.deepEqual(Buffer.from(await image.arrayBuffer()),png);
    assert.throws(()=>createRecoverySet(f),/EEXIST/);
  } finally {child.kill('SIGTERM');await new Promise<void>(resolve=>{if(child.exitCode!==null)resolve();else child.once('exit',()=>resolve());});}
});

test('GC never deletes active/referenced/grace assets and dry-run changes neither database nor files',()=>{
  const f=fixture(),a=asset(f);let result=reclaimManagedAssets(f.db,{uploadsDir:f.uploadsDir,nodeEnv:'test',allowPhysicalDeletion:true});assert.equal(result.deleted,0);
  f.db.exec("UPDATE managed_assets SET state='reclaimable'");result=reclaimManagedAssets(f.db,{uploadsDir:f.uploadsDir,nodeEnv:'test',allowPhysicalDeletion:true});assert.equal(result.referenced,1);
  f.db.exec('DELETE FROM post_media');f.db.prepare('UPDATE managed_assets SET reclaim_after_ms=?').run(Date.now()+100000);
  result=reclaimManagedAssets(f.db,{uploadsDir:f.uploadsDir,nodeEnv:'test',dryRun:true});assert.equal(result.gracePeriod,1);
  f.db.exec('UPDATE managed_assets SET reclaim_after_ms=0');const before=f.db.prepare('SELECT * FROM managed_assets').all();
  result=reclaimManagedAssets(f.db,{uploadsDir:f.uploadsDir,nodeEnv:'test',dryRun:true});assert.equal(result.eligible,1);assert.equal(result.deleted,0);
  assert.deepEqual(f.db.prepare('SELECT * FROM managed_assets').all(),before);assert.ok(fs.existsSync(a.filename));f.db.close();
});
test('GC explicit isolated flag, production hard-disable, stale candidates and duplicate execution',()=>{
  const f=fixture(),a=asset(f,'reclaimable');
  for(const options of [{nodeEnv:'production',allowPhysicalDeletion:true},{nodeEnv:'test'}]){const r=reclaimManagedAssets(f.db,{uploadsDir:f.uploadsDir,...options});assert.equal(r.disabled,true);assert.ok(fs.existsSync(a.filename));}
  const stale=reclaimManagedAssets(f.db,{uploadsDir:f.uploadsDir,nodeEnv:'test',allowPhysicalDeletion:true,beforeCandidate:()=>f.db.exec("UPDATE managed_assets SET state='active'")});assert.equal(stale.deleted,0);
  f.db.exec("UPDATE managed_assets SET state='reclaimable'");
  const removed=reclaimManagedAssets(f.db,{uploadsDir:f.uploadsDir,nodeEnv:'test',allowPhysicalDeletion:true});assert.equal(removed.deleted,1);assert.equal(fs.existsSync(a.filename),false);
  assert.equal(reclaimManagedAssets(f.db,{uploadsDir:f.uploadsDir,nodeEnv:'test',allowPhysicalDeletion:true}).deleted,0);f.db.close();
});
test('GC filesystem and post-unlink DB failures converge; durable attempt survives rollback',()=>{
  const f=fixture(),a=asset(f,'reclaimable');
  assert.equal(reclaimManagedAssets(f.db,{uploadsDir:f.uploadsDir,nodeEnv:'test',allowPhysicalDeletion:true,unlinkFile:()=>{throw Error('injected');}}).failed,1);
  f.db.exec("CREATE TRIGGER fail_gc BEFORE UPDATE OF state ON managed_assets WHEN NEW.state='deleted' BEGIN SELECT RAISE(ABORT,'injected'); END");
  assert.equal(reclaimManagedAssets(f.db,{uploadsDir:f.uploadsDir,nodeEnv:'test',allowPhysicalDeletion:true}).failed,1);assert.equal(fs.existsSync(a.filename),false);
  assert.equal((f.db.prepare('SELECT state FROM managed_assets').get() as any).state,'reclaimable');
  assert.ok((f.db.prepare("SELECT COUNT(*) n FROM operational_audit WHERE event_type='asset.delete_attempt'").get() as any).n>=2);
  f.db.exec('DROP TRIGGER fail_gc');const retried=reclaimManagedAssets(f.db,{uploadsDir:f.uploadsDir,nodeEnv:'test',allowPhysicalDeletion:true});assert.equal(retried.missing,1);assert.equal(retried.deleted,1);f.db.close();
});

test('GC also preserves legacy URL-only avatar and game-cover references',()=>{
  const f=fixture(),a=asset(f,'reclaimable'),url=`/uploads/${a.name}`;
  f.db.prepare('UPDATE users SET avatar_url=? WHERE id=1').run(url);
  assert.equal(reclaimManagedAssets(f.db,{uploadsDir:f.uploadsDir,nodeEnv:'test',dryRun:true}).referenced,1);
  f.db.exec("UPDATE users SET avatar_url=''");f.db.prepare("INSERT INTO games(name,slug,cover_image_url) VALUES ('Fixture','fixture',?)").run(url);
  assert.equal(reclaimManagedAssets(f.db,{uploadsDir:f.uploadsDir,nodeEnv:'test',allowPhysicalDeletion:true}).referenced,1);
  assert.ok(fs.existsSync(a.filename));f.db.close();
});
test('GC refuses traversal, symlinks, changed bytes, and unknown legacy files',()=>{
  const f=fixture(),a=asset(f,'reclaimable');
  f.db.exec("UPDATE managed_assets SET storage_key='../outside.png'");assert.equal(reclaimManagedAssets(f.db,{uploadsDir:f.uploadsDir,nodeEnv:'test',dryRun:true}).unsafePath,1);
  f.db.prepare('UPDATE managed_assets SET storage_key=?').run(a.name);fs.unlinkSync(a.filename);fs.symlinkSync(path.join(root,'bootstrap.db'),a.filename);
  assert.equal(reclaimManagedAssets(f.db,{uploadsDir:f.uploadsDir,nodeEnv:'test',dryRun:true}).unsafePath,1);
  fs.unlinkSync(a.filename);fs.writeFileSync(a.filename,'changed bytes');assert.equal(reclaimManagedAssets(f.db,{uploadsDir:f.uploadsDir,nodeEnv:'test',allowPhysicalDeletion:true}).failed,1);
  const legacy=path.join(f.uploadsDir,`asset-${'f'.repeat(32)}.png`);fs.writeFileSync(legacy,png);fs.utimesSync(legacy,new Date(0),new Date(0));
  reclaimManagedAssets(f.db,{uploadsDir:f.uploadsDir,nodeEnv:'test',allowPhysicalDeletion:true});assert.ok(fs.existsSync(legacy));f.db.close();
});

test('dry-run accepts a read-only database and rejects symlink upload roots and invalid bounds',()=>{
  const f=fixture(),a=asset(f,'reclaimable');
  const readOnly=new Database(f.databasePath,{readonly:true});
  const result=reclaimManagedAssets(readOnly,{uploadsDir:f.uploadsDir,nodeEnv:'production',dryRun:true});assert.equal(result.eligible,1);readOnly.close();
  const alias=f.uploadsDir+'-alias';fs.symlinkSync(f.uploadsDir,alias);
  assert.equal(reclaimManagedAssets(f.db,{uploadsDir:alias,nodeEnv:'test',dryRun:true}).unsafePath,1);
  assert.throws(()=>reclaimManagedAssets(f.db,{uploadsDir:f.uploadsDir,nodeEnv:'test',limit:501}));
  assert.ok(fs.existsSync(a.filename));f.db.close();
});

test('unresolved restore journal blocks maintenance and is never silently cleared',()=>{
  const f=fixture();fs.writeFileSync(f.databasePath+'.restore-journal','{"operations":[]}');
  assert.throws(()=>createRecoverySet(f),/Unresolved restore journal/);
  assert.ok(fs.existsSync(f.databasePath+'.restore-journal'));f.db.close();
});

test('critical HTTP mutations roll back on audit/member failure and durable audit survives deletion',async()=>{
  const f=fixture();asset(f);
  f.db.exec("UPDATE users SET role='admin' WHERE id=2; INSERT INTO users(id,username,display_name,email,password_hash,is_verified,dm_privacy) VALUES (3,'member','Member','member@test.invalid','test',1,'everyone')");
  f.db.exec("INSERT INTO groups_table(id,name,owner_id) VALUES (1,'Fixture group',1); INSERT INTO group_members(group_id,user_id,role) VALUES (1,1,'admin'),(1,3,'member'); INSERT INTO posts(id,user_id,content,group_id) VALUES (2,3,'group scoped',1)");
  const port=34000+Math.floor(Math.random()*10000),origin=`http://127.0.0.1:${port}`,secret='batch15-routes-isolated';
  const child=spawn(path.resolve('node_modules/.bin/tsx'),['server/index.ts'],{env:{...process.env,NODE_ENV:'test',DATABASE_PATH:f.databasePath,UPLOADS_DIR:f.uploadsDir,PORT:String(port),JWT_SECRET:secret,SESSION_SECRET:secret,APP_BASE_URL:origin,WEB_BASE_URL:origin,GOOGLE_CLIENT_ID:'',STEAM_API_KEY:'',RESEND_API_KEY:'',RATE_LIMIT_ENABLED:'false'},stdio:'pipe'});
  let logs='';child.stdout?.on('data',v=>logs+=v);child.stderr?.on('data',v=>logs+=v);
  const request=async(url:string,method:string,actor=2,body?:unknown)=>{
    const user=f.db.prepare('SELECT id,username,role,is_verified FROM users WHERE id=?').get(actor) as any;
    return fetch(origin+url,{method,headers:{cookie:`refugecloud_auth=${jwt.sign(user,secret,{expiresIn:'10m'})}`,origin,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
  };
  try {
    let healthy=false;for(let i=0;i<100;i++){try{healthy=(await fetch(origin+'/api/health')).ok;}catch{}if(healthy)break;await new Promise(r=>setTimeout(r,50));}assert.ok(healthy,logs);
    assert.equal((await request('/api/admin/backups/run','POST')).status,409);
    assert.equal((await request('/api/admin/backups/run','POST',1)).status,403);
    f.db.exec("CREATE TRIGGER fail_audit BEFORE INSERT ON operational_audit BEGIN SELECT RAISE(ABORT,'injected audit failure'); END");
    assert.equal((await request('/api/groups/1/owner','PUT',1,{userId:3})).status,500);
    assert.equal((f.db.prepare('SELECT owner_id FROM groups_table WHERE id=1').get() as any).owner_id,1);
    assert.equal((f.db.prepare('SELECT role FROM group_members WHERE group_id=1 AND user_id=3').get() as any).role,'member');
    assert.equal((await request('/api/groups/1','DELETE',1)).status,500);assert.ok(f.db.prepare('SELECT 1 FROM posts WHERE id=2').get());
    assert.equal((await request('/api/posts/1','DELETE',1)).status,500);assert.ok(f.db.prepare('SELECT 1 FROM post_media WHERE post_id=1').get());
    assert.equal((f.db.prepare('SELECT state FROM managed_assets').get() as any).state,'active');
    assert.equal((await request('/api/admin/users/3','DELETE')).status,500);assert.ok(f.db.prepare('SELECT 1 FROM users WHERE id=3').get());
    assert.equal((await request('/api/admin/users/3/ban','POST')).status,500);assert.equal((f.db.prepare('SELECT banned FROM users WHERE id=3').get() as any).banned,0);
    assert.equal((await request('/api/admin/users/3/role','POST',2,{role:'mod'})).status,500);assert.equal((f.db.prepare('SELECT role FROM users WHERE id=3').get() as any).role,'user');
    f.db.exec('DROP TRIGGER fail_audit');
    f.db.exec("INSERT INTO password_reset_tokens(user_id,token_hash,expires_at) VALUES (1,'prior-token','2099-01-01'); CREATE TRIGGER fail_token BEFORE INSERT ON password_reset_tokens BEGIN SELECT RAISE(ABORT,'injected token failure'); END");
    assert.equal((await request('/api/admin/users/1/password-reset-token','POST')).status,500);
    assert.equal((f.db.prepare("SELECT used_at FROM password_reset_tokens WHERE token_hash='prior-token'").get() as any).used_at,null);
    f.db.exec('DROP TRIGGER fail_token');
    f.db.exec("CREATE TRIGGER fail_member BEFORE INSERT ON dm_conversation_members WHEN NEW.user_id=3 BEGIN SELECT RAISE(ABORT,'injected membership failure'); END");
    assert.equal((await request('/api/messages','POST',1,{userId:3})).status,500);assert.equal((f.db.prepare('SELECT COUNT(*) n FROM dm_conversations').get() as any).n,0);f.db.exec('DROP TRIGGER fail_member');
    assert.equal((await request('/api/groups/1/owner','PUT',1,{userId:3})).status,200);
    assert.equal((await request('/api/admin/users/3','DELETE')).status,409);
    assert.equal((await request('/api/groups/1','DELETE',3)).status,200);
    assert.equal((await request('/api/admin/users/3','DELETE')).status,200);
    const audit=f.db.prepare("SELECT * FROM operational_audit WHERE event_type='user.deleted'").get() as any;
    assert.equal(audit.actor_id,2);assert.equal(audit.target_id,'3');assert.equal(audit.target_type,'user');
    assert.deepEqual(Object.keys(audit).sort(),['id','event_type','actor_id','target_type','target_id','created_at'].sort());
    assert.ok(f.db.prepare('SELECT 1 FROM posts WHERE id=1').get());assert.equal((f.db.pragma('foreign_key_check') as any[]).length,0);
  } finally {child.kill('SIGTERM');await new Promise<void>(resolve=>{if(child.exitCode!==null)resolve();else child.once('exit',()=>resolve());});f.db.close();}
});
