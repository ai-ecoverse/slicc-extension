import { api } from './lib.mjs';

const env = process.env;
const gh = api(env.GITHUB_REPOSITORY);
const prefix = 'cert-review-verdict';
const want = env.EXPECT_ID ?? '';
const digest = (env.EXPECT_DIGEST ?? '').replace(/^sha256:/, '');
const found = [];
for (let page = 1; page <= 10; page++) {
  const data = await gh.call(
    `actions/runs/${env.GITHUB_RUN_ID}/artifacts?per_page=100&page=${page}`
  );
  found.push(...data.artifacts.filter((a) => a.name.startsWith(prefix)));
  if (data.artifacts.length < 100) break;
}
const problems = [];
if (!want && found.length)
  problems.push(
    `the review uploaded no verdict, yet the run has ${found.map((a) => a.id).join(', ')}`
  );
if (want) {
  if (found.length !== 1)
    problems.push(`expected exactly one ${prefix} artifact, found ${found.length}`);
  const a = found.find((x) => String(x.id) === want);
  if (!a) problems.push(`artifact ${want} is not in the run`);
  else if (!digest || String(a.digest ?? '').replace(/^sha256:/, '') !== digest)
    problems.push(`artifact ${want}'s digest is not the one the review job uploaded`);
}
if (problems.length) {
  console.log(`cert-review artifacts: FAIL ${problems.join('; ')}`);
  process.exit(1);
}
console.log(
  `cert-review artifacts: PASS ${want ? `verdict artifact ${want}` : 'no verdict artifact, as the review left none'}`
);
