// A few startup files use require() on purpose: unlike an import it is not
// hoisted, so the module runs at that exact point. esbuild bundles these calls.
declare function require(id: string): any;
