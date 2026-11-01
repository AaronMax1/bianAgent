#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { loadConfig } from './config.mjs';
import { call, ensureServer, callSocket } from './client.mjs';
import { ensureWebServer } from './web-client.mjs';
import { json, publicError, check } from './util.mjs';

const help={
  usage:'codex-wallet <command> [--account ID_OR_ALIAS] [--accounts A,B] [--file request.json | --stdin]',
  commands:['accounts','account.add','account.update','account.info','account.connect','account.status','account.pairing','batch.plan','batch.run','batch.status','batch.pause','batch.resume','batch.cancel','batches','status','connect','pairing','quote','prepare','submit','sell','sell.quote','sell.v2','sell.v2.quote','confirm','operation','operations','reconcile','cancel','inspect','project.preflight','project.mint.quote','project.mint','project.fetch','project.import','projects','signature.export','events','web','service.health','service.stop'],
  note:'prepare is read-only. submit / project.mint combine internal preview and execution within explicit user payment limits. operation returns full stored details.'
};
try{
  const [command,...rawArgs]=process.argv.slice(2);
  if(!command||command==='help'||command==='--help'){process.stdout.write(json(help)+'\n');}
  else{
    const args=[],flags={};
    for(let i=0;i<rawArgs.length;i++){
      const arg=rawArgs[i];
      if(['--file','--account','--accounts'].includes(arg)){check(!flags[arg]&&rawArgs[i+1]&&!rawArgs[i+1].startsWith('--'),'INVALID_ARGUMENTS','Missing or duplicate '+arg);flags[arg]=rawArgs[++i];}
      else if(arg==='--stdin'){check(!flags[arg],'INVALID_ARGUMENTS','Duplicate --stdin');flags[arg]=true;}
      else {check(!arg.startsWith('--'),'INVALID_ARGUMENTS','Unknown option '+arg);args.push(arg);}
    }
    check(!(flags['--file']&&flags['--stdin']),'INVALID_ARGUMENTS','Use --file or --stdin');
    let params={},accountId=flags['--account'];
    if(flags['--file']){check(args.length===0,'INVALID_ARGUMENTS','Unexpected positional arguments');params=JSON.parse(readFileSync(flags['--file'],'utf8'));}
    else if(flags['--stdin']){check(args.length===0,'INVALID_ARGUMENTS','Unexpected positional arguments');params=JSON.parse(readFileSync(0,'utf8'));}
    else if(command==='project.preflight'&&args.length===1)params={url:args[0]};
    else if(command==='account.add'&&args.length===1)params={alias:args[0]};
    else if(['account.connect','account.status','account.pairing','account.info'].includes(command)&&args.length===1){check(!accountId,'INVALID_ARGUMENTS','Account selected twice');accountId=args[0];}
    else if(args.length){check(['operation','reconcile','cancel','batch.status','batch.pause','batch.resume','batch.cancel'].includes(command)&&args.length===1,'INVALID_ARGUMENTS','Use --file or --stdin for structured parameters');params={id:args[0]};}
    check(params&&typeof params==='object'&&!Array.isArray(params),'INVALID_ARGUMENTS','Request parameters must be an object');
    if(flags['--accounts']){check(command==='batch.plan'&&!accountId&&!params.accountIds,'INVALID_ARGUMENTS','--accounts is for batch.plan; select accounts only once');params.accountIds=flags['--accounts']==='all'?'all':flags['--accounts'].split(',');}
    if(command.startsWith('batch.'))check(!accountId,'INVALID_ARGUMENTS','Batch selection belongs in accountIds, not --account');
    const config=loadConfig();let data;
    if(command==='web')data=await ensureWebServer(config);
    else if(command==='service.health')data=await ensureServer(config);
    else if(command==='service.stop'){
      const h=await callSocket(config,'/health');
      check(h.pid&&h.pid!==process.pid,'INVALID_SERVICE','Invalid service PID');
      process.kill(h.pid,'SIGTERM');data={stopping:true,pid:h.pid};
    }else data=await call(config,command,params,accountId);
    if(['submit','project.mint','sell'].includes(command)&&data.id&&!data.needsReview) {
      data=Object.fromEntries(['accountId','walletAddress','batchId','id','state','status','provider','txHash','orderId','expiresAt','error','receipt','businessResult','projectQuote','saleQuote','receivedBnb','receivedAmount','remainingTokenRaw','partialFill','attempts','stage','failure'].filter(k=>data[k]!==undefined).map(k=>[k,data[k]]));
    }
    process.stdout.write(json({success:true,data})+'\n');
  }
}catch(e){process.stdout.write(json({success:false,error:publicError(e)})+'\n');process.exitCode=1;}
