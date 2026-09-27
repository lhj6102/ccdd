#!/usr/bin/env node
import { main } from '@ccdd/project/cli';
process.exitCode = await main();
