/**
 * Visual Selector — opens an iframe of a target site and lets the user
 * click elements to generate CSS selectors
 */
const Selector = (() => {
  let panel, iframe, overlay, outputEl, urlInput;
  let pickerEnabled = false;
  let lastHighlight = null;
  let onSelectCallback = null;
  let mode = "item"; // 'item' or 'fields'
  let itemSel = '';
  const PANEL_ID = "selector-panel";

  // Функція для автоматичного розпізнавання типу поля
  function detectFieldType(text, tag, attrs) {
    const lowerText = (text || "").toLowerCase();
    const allText = lowerText + " " + JSON.stringify(attrs || {}).toLowerCase();

    // Перевірка на ціну (числа з валютою)
    if (
      /\b\d+[\.,]?\d*\s*[₴$€£¥]\b/.test(lowerText) ||
      /\b\d+\s*(грн|usd|eur|uah|руб)\b/.test(allText)
    ) {
      return "ціна";
    }

    // Перевірка на валюта окремо, якщо не ціна
    if (/\b(₴|$|€|£|¥|грн|usd|eur|uah|руб)\b/.test(lowerText)) {
      return "валюта";
    }

    // Перевірка на посилання картинки
    if (
      tag === "img" ||
      (attrs &&
        (attrs.src || attrs.href) &&
        /\.(jpg|jpeg|png|gif|webp|svg)/i.test(attrs.src || attrs.href))
    ) {
      return "посилання на картинку";
    }

    // Перевірка на лінк на іншу сторінку
    if (
      tag === "a" ||
      (attrs && attrs.href && /^https?:\/\//.test(attrs.href))
    ) {
      return "лінк на іншу сторінку";
    }

    // Перевірка на артикул (великі літери + цифри)
    if (/\b[A-Z]{2,}\d+\b/.test(text) || /\b\d{6,}\b/.test(text)) {
      return "артикул";
    }

    // Перевірка на назву (довгий текст без цифр або з мінімальними)
    if (text && text.length > 10 && !/\d{4,}/.test(text)) {
      return "назва";
    }

    // Перевірка на опис (дуже довгий текст)
    if (text && text.length > 50) {
      return "опис";
    }

    // За замовчуванням
    return "невідомий";
  }

  function init() {
    panel = document.getElementById(PANEL_ID);
    iframe = document.getElementById("selector-iframe");
    overlay = document.getElementById("selector-overlay");
    outputEl = document.getElementById("selector-output");
    urlInput = document.getElementById("selector-url-input");

    document.getElementById("btn-load-url").addEventListener("click", loadUrl);
    document
      .getElementById("btn-close-selector")
      .addEventListener("click", close);
    document
      .getElementById("btn-toggle-picker")
      .addEventListener("click", togglePicker);
    document
      .getElementById("btn-use-selector")
      .addEventListener("click", useSelector);

    // Try to communicate with iframe content via postMessage
    window.addEventListener("message", onMessage);
  }

  function open(url, callback, selectMode = "item", itemSelector = "") {
    onSelectCallback = callback;
    mode = selectMode;
    itemSel = itemSelector;
    panel.classList.add("open");
    document.body.style.overflow = "hidden";
    outputEl.textContent =
      mode === "fields"
        ? '// Автоматичне сканування полів...\n'
        : '// Click "Enable picker", then click an element on the page\n';
    updatePickerBtn();
    if (url) {
      urlInput.value = url;
      loadUrl();
    }
  }

  function close() {
    panel.classList.remove("open");
    document.body.style.overflow = "";
    pickerEnabled = false;
    updatePickerBtn();
  }

  function loadUrl() {
    const url = urlInput.value.trim();
    if (!url) return UI.toast("Введіть URL", "warning");

    // Завжди скидаємо старий обробник, щоб не спрацював від попереднього режиму
    iframe.onload = null;

    // Use a proxy endpoint to bypass CORS restrictions
    const proxyUrl = `/api-proxy?url=${encodeURIComponent(url)}`;
    iframe.src = proxyUrl;
    outputEl.textContent = `// Завантаження: ${url}\n`;

    // Якщо режим fields, після завантаження сканувати автоматично
    if (mode === 'fields') {
      iframe.onload = () => {
        iframe.onload = null;
        setTimeout(() => {
          iframe.contentWindow?.postMessage({ type: "SCAN_AUTO", itemSelector: itemSel }, "*");
        }, 1000);
      };
    }
  }

  function togglePicker() {
    pickerEnabled = !pickerEnabled;
    updatePickerBtn();

    if (pickerEnabled) {
      iframe.contentWindow?.postMessage({ type: "ENABLE_PICKER" }, "*");
      outputEl.textContent += "// Вибір увімкнено — клікніть на елемент\n";
    } else {
      iframe.contentWindow?.postMessage({ type: "DISABLE_PICKER" }, "*");
    }
  }

  function updatePickerBtn() {
    const btn = document.getElementById("btn-toggle-picker");
    const useBtn = document.getElementById("btn-use-selector");
    if (mode === 'fields') {
      btn.style.display = 'none';
      useBtn.style.display = 'none';
    } else {
      btn.style.display = '';
      useBtn.style.display = '';
      if (pickerEnabled) {
        btn.classList.replace("btn-ghost", "btn-primary");
        btn.textContent = "🎯 Picker ON";
      } else {
        btn.classList.replace("btn-primary", "btn-ghost");
        btn.textContent = "🎯 Enable Picker";
      }
    }
  }

  function onMessage(e) {
    if (!e.data) return;
    if (e.data.type === "HIGHLIGHT_COUNT") {
      const count = e.data.count;
      const existingText = outputEl.textContent;
      const lines = existingText.split("\n");
      // Додати або замінити останній рядок
      if (
        lines.length > 0 &&
        lines[lines.length - 1].startsWith("// Знайдено")
      ) {
        lines[lines.length - 1] = `// Знайдено елементів: ${count}`;
      } else {
        lines.push(`// Знайдено елементів: ${count}`);
      }
      outputEl.textContent = lines.join("\n");
      return;
    }
    if (e.data.type === "FIELDS_SCANNED") {
      const fields = e.data.fields;
      outputEl.textContent =
        `// Знайдено полів: ${fields.length}\n` +
        fields.map((f) => `${f.name}: ${f.selector}`).join("\n");
      outputEl.dataset.fields = JSON.stringify(fields);
      // Автоматично застосувати
      if (onSelectCallback) {
        onSelectCallback(fields);
        setTimeout(() => close(), 2000); // Показати на 2 секунди
        UI.toast("Поля скановано: " + fields.length, "success");
      }
      return;
    }
    if (e.data.type !== "ELEMENT_SELECTED") return;
    const { selector, text, tag, classes, id, attrs } = e.data;

    if (mode === "fields") {
      // Сканувати поля в елементі
      iframe.contentWindow?.postMessage({ type: "SCAN_FIELDS", selector }, "*");
      outputEl.textContent = `// Сканування полів в елементі: ${selector}\n`;
      return;
    }

    // Автоматичне розпізнавання типу поля
    const detectedType = detectFieldType(text, tag, attrs);

    const output = [
      `// Element: <${tag}${id ? ` id="${id}"` : ""}${classes ? ` class="${classes}"` : ""}>`,
      `// Text preview: "${(text || "").slice(0, 80)}"`,
      `// CSS Selector: ${selector}`,
      `// Запропонований тип поля: ${detectedType}`,
      ``,
    ].join("\n");

    outputEl.textContent = output;
    outputEl.dataset.selector = selector;
    outputEl.dataset.detectedType = detectedType;

    // Підсвітити всі схожі елементи
    iframe.contentWindow?.postMessage({ type: "HIGHLIGHT_ALL", selector }, "*");
  }

  function useSelector() {
    if (mode === "fields") {
      // Автоматично застосовується
      return;
    }

    const selector = outputEl.dataset.selector;
    const detectedType = outputEl.dataset.detectedType;
    if (!selector) return UI.toast("Спочатку оберіть елемент", "warning");

    if (onSelectCallback) {
      onSelectCallback(selector, detectedType);
      close();
      UI.toast("Селектор застосовано: " + selector, "success");
    }
  }

  /**
   * Generate a unique CSS selector for a DOM element.
   * Injected into the iframe via the picker bookmarklet script.
   */
  const generateSelector = (el) => {
    if (!el || el === document.body) return "body";

    // Prefer ID
    if (el.id) return `#${CSS.escape(el.id)}`;

    const parts = [];
    let current = el;

    while (current && current !== document.documentElement) {
      let part = current.tagName.toLowerCase();

      if (current.id) {
        parts.unshift(`#${CSS.escape(current.id)}`);
        break;
      }

      // Add classes that look like meaningful identifiers
      const classes = Array.from(current.classList)
        .filter((c) => !/js-|is-|has-/.test(c) && c.length < 40)
        .slice(0, 2);

      if (classes.length)
        part += "." + classes.map((c) => CSS.escape(c)).join(".");

      // Add nth-child if needed for uniqueness, but skip for list items or if has classes
      const siblings = current.parentElement
        ? Array.from(current.parentElement.children).filter(
            (s) => s.tagName === current.tagName,
          )
        : [];

      if (siblings.length > 1 && classes.length === 0) {
        const idx = siblings.indexOf(current) + 1;
        if (idx > 1) {
          part += `:nth-of-type(${idx})`;
        }
      }

      parts.unshift(part);
      current = current.parentElement;

      // Stop at a meaningful parent (body, main, article, etc.)
      if (
        [
          "BODY",
          "MAIN",
          "ARTICLE",
          "SECTION",
          "HEADER",
          "FOOTER",
          "NAV",
        ].includes(current?.tagName)
      ) {
        break;
      }
    }

    return parts.join(" > ");
  };

  // Expose picker injector script (injected into iframe via srcdoc / postMessage relay)
  const PICKER_SCRIPT = `
    (function() {
      let active = false;
      let overlays = [];

      function clearOverlays() {
        overlays.forEach(o => o.remove());
        overlays = [];
      }

      function highlight(el) {
        if (!el) return;
        const r = el.getBoundingClientRect();
        const overlay = document.createElement('div');
        overlay.style.cssText = 'position:fixed;pointer-events:none;background:rgba(37,99,235,.15);border:2px solid #2563eb;z-index:99999;box-sizing:border-box;transition:all .05s';
        overlay.style.top    = r.top + 'px';
        overlay.style.left   = r.left + 'px';
        overlay.style.width  = r.width + 'px';
        overlay.style.height = r.height + 'px';
        document.body.appendChild(overlay);
        overlays.push(overlay);
      }

      function highlightAll(selector) {
        clearOverlays();
        try {
          const elements = document.querySelectorAll(selector);
          elements.forEach(el => highlight(el));
          window.parent.postMessage({ type: 'HIGHLIGHT_COUNT', count: elements.length }, '*');
        } catch (e) {
          console.warn('Invalid selector:', selector);
          window.parent.postMessage({ type: 'HIGHLIGHT_COUNT', count: 0 }, '*');
        }
      }

      function scanAuto(itemSelector) {
        try {
          const item = document.querySelector(itemSelector);
          if (!item) {
            window.parent.postMessage({ type: 'FIELDS_SCANNED', fields: [] }, '*');
            return;
          }
          const fields = [];
          const elements = item.querySelectorAll('*');
          elements.forEach(el => {
            const text = el.textContent.trim();
            if (text && text.length > 2) {
              const relSelector = getRelativeSelector(el, item);
              const type = detectFieldType(text, el.tagName, el.attributes);
              if (type !== 'невідомий') {
                fields.push({ name: type, selector: relSelector, type });
              }
            }
          });
          // Видалити дублікати за type
          const uniqueFields = [];
          const seen = new Set();
          fields.forEach(f => {
            if (!seen.has(f.type)) {
              seen.add(f.type);
              uniqueFields.push(f);
            }
          });
          window.parent.postMessage({ type: 'FIELDS_SCANNED', fields: uniqueFields }, '*');
        } catch (e) {
          console.warn('Error scanning auto:', e);
          window.parent.postMessage({ type: 'FIELDS_SCANNED', fields: [] }, '*');
        }
      }

      function getRelativeSelector(el, container) {
        const parts = [];
        let current = el;
        while (current && current !== container) {
          let p = current.tagName.toLowerCase();
          const cls = Array.from(current.classList).filter(c => c.length < 40).slice(0,2);
          if (cls.length) p += '.' + cls.map(c => CSS.escape(c)).join('.');
          parts.unshift(p);
          current = current.parentElement;
        }
        return parts.join(' > ');
      }

      function detectFieldType(text, tag, attrs) {
        const lowerText = (text || '').toLowerCase();
        const allText = lowerText + ' ' + JSON.stringify(attrs || {}).toLowerCase();

        if (/\b\d+[\.,]?\d*\s*[₴$€£¥]\b/.test(lowerText) || /\b\d+\s*(грн|usd|eur|uah|руб)\b/.test(allText)) {
          return 'ціна';
        }
        if (/\b(₴|$|€|£|¥|грн|usd|eur|uah|руб)\b/.test(lowerText)) {
          return 'валюта';
        }
        if (tag === 'img' || (attrs && (attrs.src || attrs.href) && /\.(jpg|jpeg|png|gif|webp|svg)/i.test(attrs.src || attrs.href))) {
          return 'посилання на картинку';
        }
        if (tag === 'a' || (attrs && attrs.href && /^https?:\/\//.test(attrs.href))) {
          return 'лінк на іншу сторінку';
        }
        if (/\b[A-Z]{2,}\d+\b/.test(text) || /\b\d{6,}\b/.test(text)) {
          return 'артикул';
        }
        if (text && text.length > 10 && !/\d{4,}/.test(text)) {
          return 'назва';
        }
        if (text && text.length > 50) {
          return 'опис';
        }
        return 'невідомий';
      }

      function buildSelector(el) {
        if (el.id) return '#' + CSS.escape(el.id);
        const parts = [];
        let cur = el;
        while (cur && cur.tagName !== 'BODY') {
          let p = cur.tagName.toLowerCase();
          if (cur.id) { parts.unshift('#' + CSS.escape(cur.id)); break; }
          const cls = Array.from(cur.classList).filter(c => c.length < 40).slice(0,2);
          if (cls.length) p += '.' + cls.map(c => CSS.escape(c)).join('.');
          const sibs = cur.parentElement ? Array.from(cur.parentElement.children).filter(s=>s.tagName===cur.tagName) : [];
          if (sibs.length > 1 && cls.length === 0) {
            const idx = sibs.indexOf(cur) + 1;
            if (idx > 1) {
              p += ':nth-of-type(' + idx + ')';
            }
          }
          parts.unshift(p);
          cur = cur.parentElement;
        }
        return parts.join(' > ');
      }

      document.addEventListener('mouseover', function(e) {
        if (!active) return;
        e.stopPropagation();
        clearOverlays();
        highlight(e.target);
      }, true);

      document.addEventListener('click', function(e) {
        if (!active) return;
        e.preventDefault(); e.stopPropagation();
        const el = e.target;
        window.parent.postMessage({
          type: 'ELEMENT_SELECTED',
          selector: buildSelector(el),
          text: el.textContent.trim().slice(0,100),
          tag: el.tagName.toLowerCase(),
          classes: el.className,
          id: el.id,
        }, '*');
      }, true);

      window.addEventListener('message', function(e) {
        if (e.data.type === 'ENABLE_PICKER')  { active = true; document.body.style.cursor='crosshair'; }
        if (e.data.type === 'DISABLE_PICKER') { active = false; document.body.style.cursor=''; clearOverlays(); }
        if (e.data.type === 'HIGHLIGHT_ALL') { highlightAll(e.data.selector); }
        if (e.data.type === 'SCAN_FIELDS') { scanFields(e.data.selector); }
        if (e.data.type === 'SCAN_AUTO') { scanAuto(e.data.itemSelector); }
      });
    })();
  `;

  return { init, open, close, PICKER_SCRIPT, generateSelector };
})();
