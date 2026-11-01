import { hostname,platform,release,type } from 'node:os';
import { randomBytes } from 'node:crypto';
import { deviceIdentity } from './binance-session.mjs';
import { check } from './util.mjs';

const systems={darwin:{osName:'macOS',osType:'Darwin'},linux:{osName:'Linux',osType:'Linux'},win32:{osName:'Windows',osType:'Windows_NT'}};
const releases=['24.6.0','24.5.0','24.4.0','24.3.0','24.2.0','24.1.0','24.0.0','23.6.0','23.5.0','23.4.0','23.3.0','23.2.0','23.1.0','23.0.0','22.6.0','22.5.0','22.4.0','22.3.0','22.2.0','22.1.0','22.0.0'];
export function realDeviceProfile() {
  const os=platform();
  return {platform:os,...(systems[os]||{osName:os,osType:type()}),release:release(),mac:deviceIdentity(),hostname:hostname(),
    language:Intl.DateTimeFormat().resolvedOptions().locale,timezone:Intl.DateTimeFormat().resolvedOptions().timeZone};
}
export function validateDeviceProfile(input) {
  check(input&&systems[input.platform],'INVALID_DEVICE_PROFILE','Device platform must be darwin, linux or win32');
  const p={platform:input.platform,...systems[input.platform],release:input.release,mac:typeof input.mac==='string'?input.mac.toLowerCase():input.mac,hostname:input.hostname,
    language:input.language||'en-US',timezone:input.timezone||'Asia/Tokyo'};
  check(typeof p.release==='string'&&/^[0-9][A-Za-z0-9._+-]{0,63}$/.test(p.release),'INVALID_DEVICE_PROFILE','Invalid system release');
  check(typeof p.mac==='string'&&/^(?:[0-9a-f]{2}:){5}[0-9a-f]{2}$/.test(p.mac)&&p.mac!=='00:00:00:00:00:00'&&!(parseInt(p.mac.slice(0,2),16)&1),'INVALID_DEVICE_PROFILE','MAC must be a nonzero unicast address');
  check(typeof p.hostname==='string'&&/^[A-Za-z0-9][A-Za-z0-9.-]{0,62}$/.test(p.hostname),'INVALID_DEVICE_PROFILE','Invalid device hostname');
  check(typeof p.language==='string'&&/^[A-Za-z0-9-]{2,40}$/.test(p.language),'INVALID_DEVICE_PROFILE','Invalid device language');
  try{new Intl.DateTimeFormat(p.language,{timeZone:p.timezone});}catch{check(false,'INVALID_DEVICE_PROFILE','Invalid device locale or timezone');}
  return p;
}
export const systemKey=p=>p.platform+':'+p.release;
export function newDeviceProfile(existing=[],custom) {
  let p;
  if(custom)p=validateDeviceProfile(custom);
  else {
    const selected=releases.find(r=>!existing.some(p=>systemKey(p)==='darwin:'+r));
    check(selected,'DEVICE_TEMPLATES_EXHAUSTED','Supply a distinct deviceProfile; all built-in system releases are assigned');
    const bytes=randomBytes(6);bytes[0]=(bytes[0]|2)&254;
    p=validateDeviceProfile({platform:'darwin',release:selected,mac:[...bytes].map(x=>x.toString(16).padStart(2,'0')).join(':'),hostname:'wallet-'+randomBytes(8).toString('hex')});
  }
  check(!existing.some(x=>x.mac.toLowerCase()===p.mac||x.hostname.toLowerCase()===p.hostname.toLowerCase()||systemKey(x)===systemKey(p)),'DEVICE_PROFILE_CONFLICT','MAC, hostname and system release must each differ from other accounts');
  return p;
}
export function deviceHeaders(p) {
  return {agentClientSystem:p.osName+' '+p.release,agentClientMac:p.mac,device_name:p.hostname,system_lang:p.language,timezone:p.timezone,
    system_version:p.osType+' '+p.platform+' '+p.release};
}
