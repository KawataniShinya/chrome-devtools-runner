'use strict';

const fs = require('node:fs/promises');
const {constants} = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {randomUUID} = require('node:crypto');

const arities = {
    'click target': 1, 'select option': 2, 'set date': 2, 'fill field': 2, 'expect path': 1, 'expect asset': 1, check: 1, uncheck: 1,
    'expect value': 2, 'expect count': 2, 'expect state': 2, 'expect content': 2,
    upload: 2, download: 2, 'reload fresh': 0, 'list assets': 0, 'inspect candidates': 1,
};

function parse(segment, unquote) {
    const verb = Object.keys(arities).find(key => segment === key || segment.startsWith(key + ' '));
    if (!verb) return null;
    const rest = segment.slice(verb.length).trim();
    const args = rest.match(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\S+/g)?.map(unquote) || [];
    if (args.length !== arities[verb]) throw new Error('Invalid arguments for ' + verb + '. Quote each argument containing spaces.');
    const [target, value] = args;
    if (verb === 'expect count' && !/^(0|[1-9]\d*)$/.test(value)) throw new Error('Expected a nonnegative integer count.');
    if (verb === 'expect state' && !['visible','hidden','checked','unchecked','enabled','disabled'].includes(value)) throw new Error('Unknown expected state.');
    return {type: verb.replaceAll(' ', '-'), target, value};
}

// This function executes inside the selected page. Each intermediate scope must be unique.
function locate(locator, waitForScope = false) {
    const norm = s => String(s ?? '').replace(/\s+/g, ' ').trim();
    const visible = el => el.getClientRects().length && getComputedStyle(el).visibility === 'visible';
    let root = document;
    const parts = locator.split(/\s+>>\s+/);
    for (const [index, part] of parts.entries()) {
        const descendants = () => Array.from(root.querySelectorAll('*')).filter(visible);
        let matches;
        if (part.startsWith('closest=')) {
            const ancestor = root.closest?.(part.slice(8));
            matches = ancestor ? [ancestor] : [];
        } else if (part.startsWith('text=')) {
            const name = norm(part.slice(5));
            matches = descendants().filter(el => norm(el.innerText) === name &&
                !Array.from(el.children).some(c => visible(c) && norm(c.innerText) === name));
        } else if (part.startsWith('label=')) {
            const name = norm(part.slice(6));
            matches = descendants().filter(el => el.matches('input,textarea,select,button,[role=combobox]') &&
                [el.getAttribute('aria-label'), ...Array.from(el.labels || [], l => l.innerText),
                 (el.getAttribute('aria-labelledby') || '').split(/\s+/).map(id => document.getElementById(id)?.textContent).join(' ')]
                    .some(label => label && norm(label) === name));
        } else if (part.startsWith('row=')) {
            const name = norm(part.slice(4));
            matches = Array.from(root.querySelectorAll('tr,[role=row]')).filter(row => visible(row) &&
                Array.from(row.querySelectorAll('td,th,[role=cell],[role=gridcell]')).some(c => norm(c.innerText) === name));
        } else {
            matches = Array.from(root.querySelectorAll(part.replace(/^css=/, '')));
        }
        if (index === parts.length - 1) return matches;
        if (waitForScope && matches.length === 0) return [];
        if (matches.length !== 1) throw Error('Scope matched ' + matches.length + ' elements: ' + part);
        root = matches[0];
    }
}

// Serialized into the selected page; never read the contents of editable fields.
function describeControl(el) {
    const tag = el.localName;
    const roles = {button:'button', textarea:'textbox', select:el.multiple ? 'listbox' : 'combobox', summary:'button', li:'listitem'};
    const inputs = {button:'button', submit:'button', reset:'button', radio:'radio', checkbox:'checkbox', range:'slider', number:'spinbutton', search:'searchbox'};
    const role = el.getAttribute('role') || (tag === 'a' && el.hasAttribute('href') ? 'link' :
        tag === 'input' ? inputs[el.type] || 'textbox' : roles[tag] || tag);
    const referenced = (el.getAttribute('aria-labelledby') || '').split(/\s+/)
        .map(id => document.getElementById(id)?.textContent).filter(Boolean).join(' ');
    const labels = Array.from(el.labels || [], l => l.textContent).join(' ');
    const name = referenced || el.getAttribute('aria-label') || labels || el.getAttribute('alt') ||
        (el.matches('button,a,summary,li,[role=button],[role=link],[role=tab]') ? el.innerText : '') || el.title || '';
    const rect = el.getBoundingClientRect();
    return {tag, role, name:name.trim().replace(/\s+/g, ' ').slice(0, 100),
        selector:tag + (el.id ? '#' + CSS.escape(el.id) : [...el.classList].slice(0, 3).map(c => '.' + CSS.escape(c)).join('')),
        visible:rect.width > 0 && rect.height > 0 && getComputedStyle(el).visibility === 'visible',
        enabled:!el.matches(':disabled') && !el.closest('button:disabled,[inert],[aria-disabled=true]')};
}

function inspectCandidates(find, describe, scope) {
    const roots = find(scope);
    if (roots.length !== 1) throw Error('Candidate scope matched ' + roots.length + ' elements');
    const controls = Array.from(roots[0].querySelectorAll('*')).filter(el =>
        el.matches('button,a[href],input:not([type=hidden]),select,textarea,summary,[role],[tabindex],[onclick]') ||
        (getComputedStyle(el).cursor === 'pointer' && (getComputedStyle(el.parentElement).cursor !== 'pointer' || el.matches('li'))));
    return {count:controls.length, candidates:controls.slice(0, 80).map(describe), omitted:Math.max(0, controls.length - 80)};
}

async function waitForClick(find, describe, locator, usePointer) {
    const deadline = performance.now() + 10000;
    let previous;
    let reason;
    do {
        const matches = find(locator, true);
        if (matches.length > 1) throw Error('Ambiguous click: ' + matches.length + ' matches ' + JSON.stringify(matches.slice(0, 5).map(describe)));
        const el = matches[0];
        const state = el && describe(el);
        if (!state?.visible || !state.enabled) {
            previous = undefined;
            reason = !el ? 'missing' : !state.visible ? 'hidden' : 'disabled';
        } else {
            el.scrollIntoView({block:'center', inline:'nearest', behavior:'instant'});
            const r = el.getBoundingClientRect();
            const x = (Math.max(0, r.left) + Math.min(innerWidth, r.right)) / 2;
            const y = (Math.max(0, r.top) + Math.min(innerHeight, r.bottom)) / 2;
            const geometry = [r.left,r.top,r.width,r.height].join(',');
            const hit = document.elementFromPoint(x, y);
            if (!hit || !el.contains(hit)) {
                previous = undefined;
                reason = hit ? 'covered by ' + describe(hit).selector : 'outside viewport';
            } else if (previous?.el === el && previous.geometry === geometry) {
                if (!usePointer) el.click();
                return {x,y};
            } else {
                previous = {el, geometry};
                reason = 'moving or replaced';
            }
        }
        await new Promise(resolve => setTimeout(resolve, 50));
    } while (performance.now() < deadline);
    throw Error('Click timed out: ' + locator + ' (' + reason + ')');
}

function interact(find, action) {
    const {type, target, value} = action;
    if (type === 'expect-path') return {ok: location.pathname === target, actual: location.pathname};
    if (type === 'expect-asset') {
        const paths = performance.getEntriesByType('resource').filter(r => /^https?:/.test(r.name)).map(r => new URL(r.name).pathname);
        return {ok: paths.includes(target), actual: paths};
    }
    const elements = find(target);
    const visible = el => el.getClientRects().length > 0 && getComputedStyle(el).visibility === 'visible';
    const fail = reason => ({ok: false, reason});
    if (type === 'expect-count') return {ok: elements.length === Number(value), actual: elements.length};
    if (type === 'expect-state' && value === 'hidden') return {ok: !elements.some(visible), actual: elements.filter(visible).length + ' visible'};
    if (elements.length !== 1) {
        const candidates = elements.slice(0, 4).map(el => el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (el.getAttribute('role') ? ' role=' + el.getAttribute('role') : ''));
        return fail('matched ' + elements.length + ' elements ' + candidates.join(', '));
    }
    const el = elements[0];
    if (type === 'expect-value') return {ok: el.value === value, actual: el.type === 'password' ? '[REDACTED]' : el.value};
    if (type === 'expect-content') return {ok: visible(el) && el.innerText.includes(value), actual: visible(el) ? el.innerText.slice(0, 160) : 'hidden'};
    const disabled = el.matches(':disabled,[aria-disabled=true]') || !!el.closest('[inert]');
    if (type === 'expect-state') {
        const states = {visible: visible(el), checked: el.checked === true, unchecked: el.checked === false, enabled: !disabled, disabled};
        return {ok: states[value], actual: states[value] ? value : 'not ' + value};
    }
    if (!visible(el) || disabled) return fail('target is hidden or disabled');
    if (type === 'select-option') {
        if (!(el instanceof HTMLSelectElement)) return fail('target is not a select');
        const opts = [...el.options].filter(o => o.label === value);
        if (opts.length !== 1 || opts[0].matches(':disabled')) return fail('option unavailable or ambiguous');
        el.selectedIndex = opts[0].index;
    } else if (type === 'fill-field') {
        if (!el.matches('textarea,input:not([type]),input:is([type=text],[type=email],[type=password],[type=number],[type=search],[type=url],[type=tel])') || el.readOnly) return fail('expected an editable field');
        el.value = value;
    } else if (type === 'set-date') {
        if (!(el instanceof HTMLInputElement) || !['text','date','datetime-local'].includes(el.type) || el.readOnly) return fail('expected an editable date field');
        el.value = value;
        if (el.value !== value) return fail('invalid date value');
    } else if (type === 'check' || type === 'uncheck') {
        if (!el.matches('input[type=checkbox]')) return fail('target is not a checkbox');
        if (el.checked !== (type === 'check')) el.click();
        if (el.checked !== (type === 'check')) return fail('checkbox state did not change');
    }
    if (['select-option','set-date','fill-field'].includes(type)) {
        el.dispatchEvent(new Event('input', {bubbles:true}));
        el.dispatchEvent(new Event('change', {bubbles:true}));
    }
    return {ok:true};
}

async function fileAction(cli, action, evaluate) {
    const {target, value} = action;
    if (action.type === 'upload' && target.startsWith('uid:')) {
        await cli.callTool(cli.requireTool('upload_file'), {uid:target.slice(4), filePaths:[path.resolve(value)]});
        return 'File selected';
    }
    if (!cli.browserUrl && !cli.wsEndpoint) throw Error('File transfer requires a local Chrome endpoint or an upload UID.');
    const {puppeteer} = await import('chrome-devtools-mcp/build/src/third_party/index.js');
    const connection = cli.wsEndpoint ? {browserWSEndpoint:cli.wsEndpoint} : {browserURL:cli.browserUrl};
    const browser = await puppeteer.connect({...connection, defaultViewport:null});
    const key = 'runner-' + randomUUID();
    try {
        // Identify the exact MCP-selected tab even when two tabs have the same URL.
        const url = await evaluate('() => { window[' + JSON.stringify(key) + '] = true; return location.href }');
        const pages = (await browser.pages()).filter(p => p.url() === url);
        const verified = [];
        for (const p of pages) if (await p.evaluate(k => window[k] === true, key)) verified.push(p);
        if (verified.length !== 1) throw Error('Selected tab changed before file transfer.');
        const page = verified[0];
        await page.evaluate(k => delete window[k], key);
        const handle = await page.evaluateHandle('(() => {const a=(' + locate + ')(' + JSON.stringify(target) + '); if(a.length!==1)throw Error("File target matched "+a.length+" elements");return a[0]})()');
        try {
            const el = handle.asElement();
            if (action.type === 'upload') {
                if (!await el.evaluate(e => e.matches('input[type=file]:enabled'))) throw Error('Expected an enabled file input.');
                if (!(await fs.stat(value)).isFile()) throw Error('Expected a regular upload file.');
                await el.uploadFile(path.resolve(value));
                return 'File selected';
            }
            await saveDownload(page, el, path.resolve(value));
            return 'Download saved';
        } finally { await handle.dispose(); }
    } finally { await browser.disconnect(); }
}

async function saveDownload(page, element, destination) {
    // Stage by GUID so identical suggested filenames cannot select an older file.
    await fs.access(path.dirname(destination), constants.W_OK);
    try { await fs.lstat(destination); throw Error('Download destination already exists'); }
    catch (err) { if (err.code !== 'ENOENT') throw err; }
    const client = await page.createCDPSession();
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'runner-download-'));
    let timer;
    let configured = false;
    const context = page.browserContext().id;
    const contextArgs = context ? {browserContextId:context} : {};
    try {
        const {frameTree} = await client.send('Page.getFrameTree');
        const frameId = frameTree.frame.id;
        let guid;
        const completed = new Promise((resolve, reject) => {
            timer = setTimeout(() => reject(Error('Download timed out; inspect the result before repeating the click.')), 30000);
            client.on('Browser.downloadWillBegin', event => {
                if (event.frameId !== frameId) return;
                if (guid) return reject(Error('Multiple downloads from the selected frame.'));
                guid = event.guid;
            });
            client.on('Browser.downloadProgress', event => {
                if (!guid || event.guid !== guid) return;
                if (event.state === 'completed') resolve(guid);
                if (event.state === 'canceled') reject(Error('Download canceled'));
            });
        });
        completed.catch(() => {});
        await client.send('Browser.setDownloadBehavior', {...contextArgs, behavior:'allowAndName', downloadPath:dir, eventsEnabled:true});
        configured = true;
        await element.click();
        const file = await completed;
        await fs.copyFile(path.join(dir, file), destination, constants.COPYFILE_EXCL);
    } finally {
        clearTimeout(timer);
        try {
            if (configured) await client.send('Browser.setDownloadBehavior', {...contextArgs, behavior:'default'});
        } finally {
            await client.detach().finally(() => fs.rm(dir, {recursive:true, force:true}));
        }
    }
}

async function execute(cli, action, unwrap, plainText) {
    const evaluate = async fn => unwrap(await cli.callTool(cli.requireTool('evaluate_script'), {function:fn}));
    if (action.type === 'inspect-candidates') {
        return JSON.stringify(await evaluate(`() => (${inspectCandidates})((${locate}),(${describeControl}),${JSON.stringify(action.target)})`));
    }
    if (action.type === 'click-target') {
        const pointer = cli.hasTool('click_at');
        const point = await evaluate(`async () => (${waitForClick})((${locate}),(${describeControl}),${JSON.stringify(action.target)},${pointer})`);
        if (pointer) {
            const result = await cli.callTool('click_at', {x:point.x, y:point.y, includeSnapshot:false});
            if (/# Open dialog\b/.test(plainText(result)) || result.structuredContent?.dialog) cli.pendingDialog = true;
        }
        cli.latestSnapshot = null;
        return 'Clicked target' + (cli.pendingDialog ? '; awaiting dialog' : '');
    }
    if (action.type === 'upload' || action.type === 'download') return fileAction(cli, action, evaluate);
    if (action.type === 'reload-fresh') {
        const result = await cli.callTool(cli.requireTool('navigate_page'), {type:'reload', ignoreCache:true});
        if (/Unable to reload/i.test(plainText(result))) throw Error('Fresh reload failed');
        cli.latestSnapshot = null;
        return 'Reloaded with cache bypass';
    }
    if (action.type === 'list-assets') return JSON.stringify(await evaluate("() => performance.getEntriesByType('resource').filter(e=>/^https?:/.test(e.name)).map(e=>({path:new URL(e.name).pathname,type:e.initiatorType,transferSize:e.transferSize}))"));
    const fn = '() => (' + interact + ')((' + locate + '),' + JSON.stringify(action) + ')';
    const deadline = Date.now() + (action.type.startsWith('expect-') ? 10000 : 0);
    let observation;
    do {
        observation = await evaluate(fn);
        if (observation?.ok) return 'Verified ' + action.type;
        if (Date.now() >= deadline) break;
        await new Promise(resolve => setTimeout(resolve, 100));
    } while (true);
    throw Error(action.type + ' ' + action.target + (action.type.startsWith('expect-') ? ' expected '+action.value : '') + ': ' + (observation?.reason ?? JSON.stringify(observation?.actual)));
}

module.exports = {parse, execute, types:new Set(Object.keys(arities).map(k => k.replaceAll(' ', '-')))};
