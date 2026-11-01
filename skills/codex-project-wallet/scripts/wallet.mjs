#!/usr/bin/env node
import { existsSync,readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath,pathToFileURL } from 'node:url';
const installation=new URL('../installation.json',import.meta.url);
const root=existsSync(installation)?JSON.parse(readFileSync(installation,'utf8')).packageRoot:fileURLToPath(new URL('../../../',import.meta.url));
await import(pathToFileURL(resolve(root,'src/cli.mjs')).href);
