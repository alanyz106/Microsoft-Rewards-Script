(() => {
  const links = document.querySelectorAll('a');
  const result = [];
  for(let i=0; i<Math.min(links.length, 30); i++) {
    const a = links[i];
    result.push({
      idx: i,
      text: a.innerText.replace(/\s+/g, ' ').trim().slice(0, 80),
      href: (a.href || '').slice(0, 150),
      cls: (a.className || '').slice(0, 50),
      id: a.id || ''
    });
  }
  return JSON.stringify(result, null, 2);
})()
