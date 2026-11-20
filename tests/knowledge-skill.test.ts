import test from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import {openDatabase,migrate} from "../server/db.js";
import {attachAuth,issueSession} from "../server/auth.js";
import {knowledgeSkillRoutes} from "../server/knowledge-skill.js";
import {refreshKnowledgeIndex} from "../server/retrieval-index.js";
import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {randomUUID} from "node:crypto";

test("external skill reads scoped full text without a token",async()=>{
 const db=await openDatabase("","memory://"), app=Fastify();
 try {
 await migrate(db);await app.register(cookie);attachAuth(app,db);knowledgeSkillRoutes(app,db);
 const id=randomUUID();
 await db.query("INSERT INTO users(id,username,display_name,password_hash,role) VALUES($1,'reader','用户','unused','member')",[id]);
 await db.query("INSERT INTO kb_products(product_id,product_code,name,status) VALUES('p','P','平台','active')");
 await db.query("INSERT INTO kb_product_versions(product_version_id,product_id,version,status) VALUES('v','p','v1','active'),('v2','p','v2','active')");
 const raw="# 门禁\n\n"+"跨控制器反潜回。".repeat(300);
 await db.query("INSERT INTO kb_sale_items(sale_item_id,product_version_id,name,specification_md,source_markdown,status) VALUES('a','v','门禁','跨控制器反潜回',$1,'active'),('b','v','访客','访客预约',NULL,'active'),('c','v2','门禁','其他版本',NULL,'active'),('d','v','草稿',NULL,NULL,'draft')",[raw]);
 await refreshKnowledgeIndex(db,new AbortController().signal);
 const root="/api/knowledge/skill",headers={cookie:"workspace_session="+(await issueSession(db,id)).token,"x-workspace-request":"1"};
 const archive=await app.inject({url:root+"/download",headers});assert.equal(archive.rawPayload.subarray(0,2).toString(),"PK");
 const addr=await app.listen({port:0,host:"127.0.0.1"});
 const run=async(...args:string[])=>JSON.parse((await promisify(execFile)(process.execPath,["--import","data:text/javascript,"+encodeURIComponent(`const original=fetch;globalThis.fetch=(url,opts)=>{if(url.origin!=="http://10.1.219.160:4317" || opts.headers.Authorization)throw Error("unexpected connection");return original(new URL(url.pathname+url.search,${JSON.stringify(addr)}),opts)}`),"agent/pingbiao-knowledge/scripts/kb.mjs",...args])).stdout);
 assert.equal((await run("products")).versions.length,2);
 const first=await run("catalog","--full","--version","v","--limit","1");
 assert.equal(first.total,2);assert.equal(first.complete,false);assert.equal(first.items[0].fields.source_markdown,raw);
 const last=await run("catalog","--full","--version","v","--cursor",first.next_cursor);
 assert.equal(last.complete,true);assert.equal(last.items[0].source_format,"structured_fields");
 const items=await run("items","--version","v","a","c","d");assert.deepEqual(items.missing_ids,["c","d"]);assert.equal(items.items.length,1);
 assert.equal((await run("search","反潜回","--version","v","--mode","keyword")).results[0].saleItemId,"a");
 assert.equal((await app.inject({url:root+"/download"})).statusCode,401);
 }finally{await app.close();await db.close();}
});
