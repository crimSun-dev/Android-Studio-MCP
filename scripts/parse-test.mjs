// Checks parseBuildOutput against representative Kotlin / javac / AAPT2 / Gradle failure output.
import assert from "node:assert/strict";
import { parseBuildOutput } from "../dist/tools/gradle.js";

const out = String.raw`> Task :app:compileDebugKotlin FAILED
e: file:///G:/Proj/app/src/main/java/com/x/MainActivity.kt:12:5 Unresolved reference 'foo'.
w: file:///G:/Proj/app/src/main/java/com/x/A.kt:3:1 Parameter never used
e: C:\p\B.kt: (7, 9): Type mismatch
C:\p\C.java:4: error: cannot find symbol
ERROR: C:\p\res\layout\main.xml:10: AAPT: error: attribute android:foo not found.

FAILURE: Build failed with an exception.

* What went wrong:
Execution failed for task ':app:compileDebugKotlin'.
> Compilation error. See log for more details

* Try:
> Run with --stacktrace`;

const { diagnostics, failure } = parseBuildOutput(out);
assert.deepEqual(
  diagnostics.map((d) => [d.severity, d.file, d.line, d.column]),
  [
    ["error", "G:/Proj/app/src/main/java/com/x/MainActivity.kt", 12, 5],
    ["warning", "G:/Proj/app/src/main/java/com/x/A.kt", 3, 1],
    ["error", String.raw`C:\p\B.kt`, 7, 9],
    ["error", String.raw`C:\p\C.java`, 4, undefined],
    ["error", String.raw`C:\p\res\layout\main.xml`, 10, undefined],
  ],
);
assert.match(failure, /^Execution failed for task ':app:compileDebugKotlin'/);
console.log("parseBuildOutput: ok");
