const fs=require('fs'), vm=require('vm'), assert=require('node:assert/strict');
const root=require('node:path').resolve(__dirname,'..');
const units=require(root+'/services/inventory-usage-units');
assert.equal(units.convertedQuantity(2,'libras','gramos'),907.18);
assert.equal(units.convertedQuantity(2,'docenas','unidades'),24);
assert.equal(units.convertedQuantity(500,'ml','litros'),0.5);
assert.throws(()=>units.convertedQuantity(1,'litros','gramos'));
assert.throws(()=>units.convertedQuantity(0,'g','g'));
assert.throws(()=>units.validDate('2026-02-30'));
const routes={}, router={get:(p,...h)=>routes['GET '+p]=h,post:(p,...h)=>routes['POST '+p]=h,delete:(p,...h)=>routes['DELETE '+p]=h};
let state={items:[{id:1,name:'Pollo',unit:'gramos',quantity:1000,is_active:1},{id:2,name:'Queso',unit:'unidades',quantity:1,is_active:1}],notes:[],movements:[]};
let failMovement=false;
const db={async transaction(fn){const backup=structuredClone(state);try{return await fn({});}catch(e){state=backup;throw e;}},async query(sql,{replacements:r=[]}={}){
 if(sql.startsWith('CREATE TABLE'))return [];
 if(sql.startsWith('SELECT * FROM inventory_items WHERE id ='))return [[state.items.find(x=>x.id===Number(r[0]))].filter(Boolean)];
 if(sql.startsWith('INSERT IGNORE')){if(!state.notes.some(x=>x.request_id===r[0]))state.notes.push({id:state.notes.length+1,request_id:r[0],usage_date:r[1],inventory_item_id:r[2],item_name:r[3],input_quantity:r[4],input_unit:r[5],inventory_quantity:r[6],inventory_unit:r[7],notes:r[8],user_id:r[9],user_name:r[10],status:'pending'});return [];}
 if(sql.includes('WHERE request_id ='))return [state.notes.filter(x=>x.request_id===r[0])];
 if(sql.includes('FROM inventory_usage_notes WHERE id IN'))return [state.notes.filter(x=>r[0].includes(x.id)&&x.usage_date===r[1])];
 if(sql.includes('FROM inventory_items WHERE id IN'))return [state.items.filter(x=>r[0].includes(x.id))];
 if(sql.startsWith('UPDATE inventory_items')){state.items.find(x=>x.id===r[1]).quantity-=r[0];return [];}
 if(sql.startsWith('INSERT INTO inventory_movements')){if(failMovement)throw Error('storage failure');state.movements.push(r);return [];}
 if(sql.includes("SET status = 'applied'")){state.notes.find(x=>x.id===r[1]).status='applied';return [];}
 if(sql.includes('FROM inventory_usage_notes WHERE id ='))return [state.notes.filter(x=>x.id===r[0])];
 if(sql.includes("SET status = 'cancelled'")){state.notes.find(x=>x.id===r[0]).status='cancelled';return [];}
 throw Error('Unhandled SQL '+sql);
}};
const protect=(req,res,next)=>next();
const supervisor=(req,res,next)=>req.user.role==='supervisor'?next():res.status(403).json({success:false});
const sandbox={module:{exports:{}},require:n=>({'express':{Router:()=>router},'../config/database':{sequelize:db},'../middleware/auth':{protect,requireSupervisor:supervisor},'../services/inventory-usage-units':units,'../services/push':{revisarEnSegundoPlano(){}}}[n])};
vm.runInNewContext(fs.readFileSync(root+'/routes/inventory-usage.js','utf8'),sandbox);
async function call(key,body,user={id:1,name:'Empleado',role:'employee'},params={}){
 const req={body,user,params,query:{}},res={code:200,status(n){this.code=n;return this},json(v){this.body=v;return this}};
 const handlers=routes[key];async function run(i){if(i<handlers.length)await handlers[i](req,res,()=>run(i+1));}await run(0);return res;
}
const sup={id:2,name:'Supervisor',role:'supervisor'};
(async()=>{
 const first={requestId:'10000000-0000-0000-0000-000000000001',date:'2026-10-13',inventoryItemId:1,quantity:0.5,unit:'libras'};
 assert.equal((await call('POST /',first)).code,200);assert.equal(state.items[0].quantity,1000);
 await call('POST /',first);assert.equal(state.notes.length,1,'save retry duplicates');
 assert.equal((await call('POST /',{...first,quantity:2})).code,409,'UUID reuse changed data');
 assert.equal((await call('POST /apply',{date:first.date,ids:[1]})).code,403);
 assert.equal((await call('POST /apply',{date:first.date,ids:[1]},sup)).code,200);
 assert.equal(state.items[0].quantity,773.2);assert.equal(state.movements.length,1);
 await call('POST /apply',{date:first.date,ids:[1]},sup);assert.equal(state.items[0].quantity,773.2);assert.equal(state.movements.length,1,'apply retry duplicates');
 assert.equal((await call('DELETE /:id',{},sup,{id:'1'})).code,409,'cancel applied forbidden');
 await call('POST /',{...first,requestId:'10000000-0000-0000-0000-000000000002',quantity:100,unit:'g'});
 await call('POST /',{...first,requestId:'10000000-0000-0000-0000-000000000003',inventoryItemId:2,quantity:2,unit:'unidades'});
 assert.equal((await call('POST /apply',{date:first.date,ids:[2,3]},sup)).code,409);
 assert.equal(state.items[0].quantity,773.2,'shortage must not partially apply');assert.equal(state.notes[1].status,'pending');
 failMovement=true;assert.equal((await call('POST /apply',{date:first.date,ids:[2]},sup)).code,500);assert.equal(state.items[0].quantity,773.2,'rollback');assert.equal(state.notes[1].status,'pending');failMovement=false;
 assert.equal((await call('DELETE /:id',{}, {id:3,role:'employee'},{id:'2'})).code,403);
 assert.equal((await call('DELETE /:id',{},undefined,{id:'2'})).code,200);assert.equal(state.notes[1].status,'cancelled');
 assert.equal((await call('POST /apply',{date:first.date,ids:[2]},sup)).code,409);
 console.log('PASS: conversion, pending without stock change, role enforcement, retries, shortage atomicity, rollback, cancellation ownership.');
})().catch(e=>{console.error(e);process.exitCode=1});
