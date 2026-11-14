const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const {spawn, execFileSync} = require('node:child_process');
const asar = require('@electron/asar');
async function main() {
  const [appRoot, expectedArch] = process.argv.slice(2);
  if (!appRoot || process.arch !== expectedArch) throw Error('Native runner architecture mismatch');
  const mac = process.platform === 'darwin';
  const resources = path.resolve(appRoot, mac ? 'Contents/Resources' : 'resources');
  const archive = path.join(resources, 'app.asar');
  const pkg = JSON.parse(asar.extractFile(archive, 'package.json'));
  const sourcePkg = require('../package.json');
  if (pkg.version !== sourcePkg.version) throw Error('Packaged version mismatch');
  const entries = asar.listPackage(archive);
  if (entries.some(p => /(^|\/)(orders\.db|cookies\.json|storage-state\.json|source-manifest\.json|handoff\.md|\.env)(\/|$)/i.test(p))) throw Error('Private data found in archive');
  const electron = path.resolve(appRoot, mac ? 'Contents/MacOS/线上经营工具' : '线上经营工具.exe');
  const modules = ['playwright', 'playwright-extra', 'puppeteer-extra-plugin-stealth', 'electron-updater'];
  const code = `const r=require('node:module').createRequire(${JSON.stringify(path.join(archive,'package.json'))}); for(const m of ${JSON.stringify(modules)}) r(m); if(process.arch!==${JSON.stringify(expectedArch)}) throw Error('Electron architecture mismatch'); console.log('bundled-node-ok')`;
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'oba-runtime-check-'));
  const output = execFileSync(electron, ['-e', code], {cwd:temp, env:{...process.env,ELECTRON_RUN_AS_NODE:'1',NODE_PATH:''},timeout:30000,encoding:'utf8'});
  if (!output.includes('bundled-node-ok')) throw Error('Bundled Node check failed');
  const server = net.createServer(); await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const port = server.address().port; await new Promise(r=>server.close(r));
  const python = path.join(resources,'workbench',mac?'tutianduo-workbench':'tutianduo-workbench.exe');
  const child = spawn(python, [], {cwd:temp,env:{...process.env,TUTIANDUO_DATA_DIR:path.join(temp,'data'),TUTIANDUO_PORT:String(port)},stdio:['ignore','pipe','pipe']});
  let stderr = ''; child.stderr.on('data',d=>stderr+=d); let spawnError; child.on('error',e=>spawnError=e);
  let healthy=false;
  try {
    for(let i=0;i<60;i++) {
      if(spawnError) throw spawnError;
      if(child.exitCode!==null) throw Error('Bundled Python exited: '+stderr.slice(-1500));
      try {const r=await fetch(`http://127.0.0.1:${port}/api/health`,{signal:AbortSignal.timeout(1000)}); const h=await r.json(); if(h.service==='tutianduo-order-workbench'){healthy=true;break}} catch {}
      await new Promise(r=>setTimeout(r,500));
    }
    if(!healthy) throw Error('Bundled workbench health check failed: '+stderr.slice(-1500));
  } finally {child.kill();}
  if(mac) execFileSync('codesign',['--verify','--deep','--strict',path.resolve(appRoot)],{stdio:'pipe'});
  const report={version:pkg.version,platform:process.platform,arch:expectedArch,bundledNode:true,productionModules:modules,bundledPythonHealth:true,privateArchiveFileCheck:true,realShopTest:false};
  fs.mkdirSync('runtime-verification',{recursive:true});
  fs.writeFileSync(`runtime-verification/${process.platform}-${expectedArch}.json`,JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(report));
}
main().catch(e=>{console.error(e.message);process.exitCode=1});
