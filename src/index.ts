#!/usr/bin/env node

import { dispatch } from "./cli.js";

dispatch(process.argv.slice(2));
