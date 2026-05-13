const axios = require("axios");

function createVisualProxyHandler() {
  return async function visualProxyHandler(req, res) {
    const url = req.query.url;

    if (!url || !/^https?:\/\//.test(url)) {
      return res.status(400).send("Invalid URL");
    }

    try {
      const response = await axios.get(url, {
        timeout: 15000,
        responseType: "text",
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          Accept:
            "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "uk,en;q=0.5",
        },
        maxRedirects: 5,
      });

      let html = response.data;
      const origin = new URL(url).origin;

      const pickerScript = `<script>
(function(){
  let active=false,overlays=[];
  function clearOverlays(){overlays.forEach(function(o){o.remove();});overlays=[];}
  function highlight(el){
    if(!el)return;
    var r=el.getBoundingClientRect();
    var o=document.createElement('div');
    o.style.cssText='position:fixed;pointer-events:none;background:rgba(37,99,235,.15);border:2px solid #2563eb;z-index:2147483647;box-sizing:border-box;top:'+r.top+'px;left:'+r.left+'px;width:'+r.width+'px;height:'+r.height+'px';
    document.body.appendChild(o);overlays.push(o);
  }
  function highlightAll(selector){
    clearOverlays();
    try{var els=document.querySelectorAll(selector);els.forEach(function(el){highlight(el);});window.parent.postMessage({type:'HIGHLIGHT_COUNT',count:els.length},'*');}
    catch(e){window.parent.postMessage({type:'HIGHLIGHT_COUNT',count:0},'*');}
  }
  function buildSel(el){
    if(el.id)return '#'+CSS.escape(el.id);
    var parts=[];var cur=el;
    while(cur&&cur.tagName!=='BODY'){
      var p=cur.tagName.toLowerCase();
      if(cur.id){parts.unshift('#'+CSS.escape(cur.id));break;}
      var cls=Array.from(cur.classList).filter(function(c){return c.length<40;}).slice(0,2);
      if(cls.length)p+='.'+cls.map(function(c){return CSS.escape(c);}).join('.');
      var sibs=cur.parentElement?Array.from(cur.parentElement.children).filter(function(s){return s.tagName===cur.tagName;}):[];
      if(sibs.length>1&&cls.length===0)p+=':nth-of-type('+(sibs.indexOf(cur)+1)+')';
      parts.unshift(p);cur=cur.parentElement;
    }
    return parts.join(' > ');
  }
  function getRelSel(el,container){
    var parts=[];var cur=el;
    while(cur&&cur!==container){
      var p=cur.tagName.toLowerCase();
      var cls=Array.from(cur.classList).filter(function(c){return c.length<40;}).slice(0,2);
      if(cls.length)p+='.'+cls.map(function(c){return CSS.escape(c);}).join('.');
      parts.unshift(p);cur=cur.parentElement;
    }
    return parts.join(' > ');
  }
  function detectType(text,tag){
    var lo=(text||'').toLowerCase();
    if(/\\b\\d+[\\.,]?\\d*\\s*[₴$€£¥]\\b/.test(lo)||/\\b\\d+\\s*(грн|usd|eur|uah|руб)\\b/.test(lo))return 'ціна';
    if(/\\b(₴|\\$|€|£|¥|грн|usd|eur|uah|руб)\\b/.test(lo))return 'валюта';
    if(tag==='img')return 'посилання на картинку';
    if(tag==='a')return 'лінк на іншу сторінку';
    if(/\\b[A-Z]{2,}\\d+\\b/.test(text)||/\\b\\d{6,}\\b/.test(text))return 'артикул';
    if(text&&text.length>10&&!/\\d{4,}/.test(text))return 'назва';
    if(text&&text.length>50)return 'опис';
    return 'невідомий';
  }
  function scanContainer(container){
    var fields=[];
    container.querySelectorAll('*').forEach(function(el){
      var text=el.textContent.trim();
      if(text&&text.length>2){
        var type=detectType(text,el.tagName.toLowerCase());
        if(type!=='невідомий')fields.push({name:type,selector:getRelSel(el,container),type:type});
      }
    });
    var unique=[];var seen={};
    fields.forEach(function(f){if(!seen[f.type]){seen[f.type]=true;unique.push(f);}});
    return unique;
  }
  function scanAuto(itemSelector){
    try{
      var item=document.querySelector(itemSelector);
      if(!item){window.parent.postMessage({type:'FIELDS_SCANNED',fields:[]},'*');return;}
      window.parent.postMessage({type:'FIELDS_SCANNED',fields:scanContainer(item)},'*');
    }catch(e){window.parent.postMessage({type:'FIELDS_SCANNED',fields:[]},'*');}
  }
  function scanFields(selector){
    try{
      var container=document.querySelector(selector);
      if(!container){window.parent.postMessage({type:'FIELDS_SCANNED',fields:[]},'*');return;}
      window.parent.postMessage({type:'FIELDS_SCANNED',fields:scanContainer(container)},'*');
    }catch(e){window.parent.postMessage({type:'FIELDS_SCANNED',fields:[]},'*');}
  }
  document.addEventListener('mouseover',function(e){if(!active)return;e.stopPropagation();clearOverlays();highlight(e.target);},true);
  document.addEventListener('click',function(e){if(!active)return;e.preventDefault();e.stopPropagation();
    window.parent.postMessage({type:'ELEMENT_SELECTED',selector:buildSel(e.target),text:e.target.textContent.trim().slice(0,100),tag:e.target.tagName.toLowerCase(),classes:e.target.className,id:e.target.id},'*');
  },true);
  window.addEventListener('message',function(e){
    if(e.data.type==='ENABLE_PICKER'){active=true;document.body.style.cursor='crosshair';}
    if(e.data.type==='DISABLE_PICKER'){active=false;document.body.style.cursor='';clearOverlays();}
    if(e.data.type==='HIGHLIGHT_ALL'){highlightAll(e.data.selector);}
    if(e.data.type==='SCAN_AUTO'){scanAuto(e.data.itemSelector);}
    if(e.data.type==='SCAN_FIELDS'){scanFields(e.data.selector);}
  });
})();
</script>`;

      if (/<head[\s>]/i.test(html)) {
        html = html.replace(
          /(<head[^>]*>)/i,
          `$1<base href="${origin}/">${pickerScript}`,
        );
      } else {
        html = pickerScript + html;
      }

      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.setHeader("X-Frame-Options", "SAMEORIGIN");
      res.setHeader("Content-Security-Policy", "");
      res.send(html);
    } catch (err) {
      res.status(502).send(`<html><body style="font-family:sans-serif;padding:40px;color:#ef4444">
      <h2>Не вдалося завантажити сторінку</h2>
      <p>${err.message}</p>
      <p style="color:#64748b;font-size:13px">Деякі сайти блокують зовнішні запити.</p>
    </body></html>`);
    }
  };
}

module.exports = createVisualProxyHandler;
