const fs = require('fs');
const html = fs.readFileSync('index.html', 'utf8');
const m = html.match(/<script[^>]*>([\s\S]*?)<\/script>/);
if (!m) { console.log('no inline script'); process.exit(1); }
try { new Function(m[1]); console.log('JS OK'); } 
catch (e) { 
  console.log('ERROR:', e.message); 
  const lines = m[1].split('\n');
  const errLine = parseInt(e.stack?.split('\n')[1]?.match(/<anonymous>:(\d+)/)?.[1] || 0);
  console.log('Line', errLine, ':', lines[errLine-1]);
  console.log('Context:', lines.slice(Math.max(0,errLine-3), errLine+2).map((l,i)=>(Math.max(0,errLine-3)+i+1)+': '+l).join('\n'));
}