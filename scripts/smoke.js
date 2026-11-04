'use strict';

// 手动冒烟测试：在真实模式下调用扶摇接口，验证行情 / 热榜 / 交易日历可用。
const fs = require('fs');
const path = require('path');

const envPath = path.join(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const provider = require('../provider');
provider.setMode('real');

(async () => {
  const price = await provider.getPrice('600519.SH');
  const heat = await provider.getHotRank('600519.SH');
  const calendar = await provider.isTradingDay('20261103');
  console.log('price:', JSON.stringify(price));
  console.log('heat:', JSON.stringify(heat));
  console.log('calendar:', JSON.stringify(calendar));
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
