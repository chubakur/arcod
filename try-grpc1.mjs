import { readFile } from 'node:fs/promises';
import { parse } from 'file:///Users/chubakur/projects/arcod/src/parser.ts';
import { grpcProto } from 'file:///Users/chubakur/projects/arcod/src/emit/grpc.ts';
const src = await readFile('/Users/chubakur/projects/arcod/examples/tasks-sql/main.arc', 'utf8');
console.log(grpcProto(parse(src, 'main.arc')));
