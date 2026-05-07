#!/usr/bin/env node

const fs = require('node:fs/promises');
const path = require('node:path');

const apiBase = process.env.GITHUB_API_URL || 'https://api.github.com';
const outDir = path.join(process.cwd(), 'badges');
const token =
  process.env.BADGE_GITHUB_TOKEN ||
  process.env.GH_STATS_TOKEN ||
  process.env.GITHUB_TOKEN;

const usingActionsToken =
  process.env.GITHUB_ACTIONS === 'true' &&
  !process.env.BADGE_GITHUB_TOKEN &&
  !process.env.GH_STATS_TOKEN;

if (!token) {
  throw new Error('Set BADGE_GITHUB_TOKEN or GH_STATS_TOKEN first.');
}

if (usingActionsToken) {
  throw new Error(
    'Set a BADGE_GITHUB_TOKEN secret with repo read access to include ' +
      'private repositories.'
  );
}

function makeUrl(pathname, params = {}) {
  const url = new URL(pathname, apiBase);

  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) {
      url.searchParams.set(key, String(value));
    }
  }

  return url;
}

async function githubGet(pathname, params = {}, allowedStatuses = []) {
  const response = await fetch(makeUrl(pathname, params), {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'User-Agent': 'github-user-stat-badges',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });

  if (allowedStatuses.includes(response.status)) {
    return { data: null, headers: response.headers, status: response.status };
  }

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `GitHub API ${response.status} for ${pathname}: ${body}`
    );
  }

  return {
    data: await response.json(),
    headers: response.headers,
    status: response.status,
  };
}

async function getAllPages(pathname, params = {}) {
  const items = [];
  let page = 1;

  while (true) {
    const { data } = await githubGet(pathname, {
      ...params,
      page,
      per_page: 100,
    });

    items.push(...data);

    if (data.length < 100) {
      break;
    }

    page += 1;
  }

  return items;
}

function parseLastPage(linkHeader) {
  if (!linkHeader) {
    return null;
  }

  const match = linkHeader.match(/[?&]page=(\d+)>; rel="last"/);
  return match ? Number(match[1]) : null;
}

function repoApiPath(repoFullName, suffix) {
  const encodedName = repoFullName
    .split('/')
    .map(encodeURIComponent)
    .join('/');

  return `/repos/${encodedName}/${suffix}`;
}

async function getCommitCount(repo, login) {
  const { data, headers, status } = await githubGet(
    repoApiPath(repo.full_name, 'commits'),
    { author: login, per_page: 1 },
    [404, 409, 422]
  );

  if (status !== 200 || !Array.isArray(data) || data.length === 0) {
    return 0;
  }

  return parseLastPage(headers.get('link')) || data.length;
}

function renderNumberSvg(value) {
  const text = String(value);
  const width = Math.max(20, text.length * 7 + 10);
  const center = width / 2;

  return [
    '<svg xmlns="http://www.w3.org/2000/svg"',
    ` width="${width}" height="16"`,
    ` role="img" aria-label="${text}">`,
    `<text x="${center}" y="12" text-anchor="middle" fill="#666"`,
    ' font-family="Verdana,Geneva,sans-serif" font-size="11">',
    text,
    '</text></svg>',
  ].join('');
}

async function writeBadge(name, value) {
  const filePath = path.join(outDir, `${name}.svg`);
  await fs.writeFile(filePath, `${renderNumberSvg(value)}\n`, 'utf8');
  console.log(`${name}: ${value}`);
}

async function main() {
  await fs.mkdir(outDir, { recursive: true });

  const { data: user } = await githubGet('/user');
  const repos = await getAllPages('/user/repos', {
    affiliation: 'owner',
    sort: 'full_name',
    visibility: 'all',
  });

  let commitCount = 0;

  for (const repo of repos) {
    commitCount += await getCommitCount(repo, user.login);
  }

  await writeBadge('repos', repos.length);
  await writeBadge('stars', sum(repos, 'stargazers_count'));
  await writeBadge('forks', sum(repos, 'forks_count'));
  await writeBadge('commits', commitCount);
}

function sum(items, field) {
  return items.reduce((total, item) => total + (item[field] || 0), 0);
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
