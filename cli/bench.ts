export async function runBench() {
  const { execFileSync } = await import("node:child_process");
  execFileSync("npx", ["tsx", "benchmark/benchmark.ts"], { stdio: "inherit" });
}
