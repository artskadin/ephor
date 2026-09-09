// Imported first: React picks its build from NODE_ENV when it loads. One
// frame of 200 nodes: 75 ms on the dev build, 51 ms on production. `??=`
// leaves `NODE_ENV=development ephor …` for debugging React itself.
process.env.NODE_ENV ??= "production";
