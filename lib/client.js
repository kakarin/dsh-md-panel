/**
 * dsh-md-panel —— 浏览器半侧（手写的 __ModuleLoader__ bundle，无需构建工具）。
 *
 * 干这些事：
 *   1. 注册一个右侧栏页类型（kind: kbPanel）——会话标题右侧的「知识库」按钮、
 *      右栏引导页的「知识库」胶囊都能把它开出来；正文挂在 sidebar.right.pane.tab、
 *      页签标题挂在 sidebar.right.pane.tab.title，都用 id = dsh-md-panel；
 *      面板顶部有「收起 / 展开目录」，宽屏时目录与正文并排、窄屏时上下叠。
 *   2. 面板目录区：栏目树 / 全文搜索 / 最近更新 / 收藏 / 待补 frontmatter 五种视图，
 *      按 type 与标签过滤；
 *   3. 正文区：Markdown 预览（标题锚点、表格、代码、图片走 /md-panel/api/asset），
 *      frontmatter 徽章、出链 / 反向链接、大纲；
 *   4. 实时同步：SSE (/md-panel/api/events) 一有变化就刷新树，当前文档变了就静默重载，
 *      顶栏状态点和右下角提示会告诉主人「刚刚同步了几个变更」；
 *   5. 接入对话：整篇「解读」、选中段落「解读 / 追问」、底部「问一句」默认把问题
 *      追加进**当前会话**的输入栏（conversation.input.left 桥拿 inputActions，
 *      captureInsertion + insertText，不覆盖已打的字）；底部「新会话提问」才走
 *      ctx.uiWorkspace.startSession(…{prompt}) 另开一个会话。
 *
 * 与宿主只走同源 HTTP，不碰 RPC。只 require 宿主已提供的 react。
 */

window.__ModuleLoader__.load({
  id: 'dsh-md-panel',
  factory: function (require) {
    var module = { exports: {} }
    var exports = module.exports

    var React = require('react')
    var h = React.createElement
    var useCallback = React.useCallback
    var useEffect = React.useEffect
    var useMemo = React.useMemo
    var useRef = React.useRef
    var useState = React.useState

    var API = '/md-panel/api'
    var PANEL_ID = 'dsh-md-panel'
    var STYLE_ID = 'dsh-md-panel-styles'
    var STAR_KEY = 'dsh-md-panel:stars'
    var SIDE_KEY = 'dsh-md-panel:side-collapsed'
    var KB_KIND = 'kbPanel'
    var TYPE_LABEL = {
      device: '设备',
      service: '服务',
      project: '项目',
      credential: '凭据',
      doc: '文档',
    }
    var TYPE_TONE = {
      device: 'info',
      service: 'ok',
      project: 'brand',
      credential: 'warn',
      doc: 'muted',
    }

    // 客户端服务句柄（面板要用 layout 切回对话、uiWorkspace 开新会话）
    var services = { layout: null, uiWorkspace: null, conversation: null, sidebarRight: null, workspaces: null }

    // ---- 同源 API ---------------------------------------------------------

    function readJson(response) {
      return response.text().then(function (source) {
        var data = null
        try {
          data = source === '' ? null : JSON.parse(source)
        } catch (error) {
          data = null
        }
        if (!response.ok) {
          var message = data && data.error ? data.error : 'HTTP ' + response.status
          var failure = new Error(message)
          failure.status = response.status
          throw failure
        }
        return data
      })
    }

    function apiGet(path) {
      return fetch(API + path, { cache: 'no-store' }).then(readJson)
    }

    function apiPost(path, body) {
      return fetch(API + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body || {}),
      }).then(readJson)
    }

    // ---- 小工具 -----------------------------------------------------------

    function pad2(value) {
      return value < 10 ? '0' + value : String(value)
    }

    function timeLabel(millis) {
      if (typeof millis !== 'number' || millis <= 0) return '—'
      var date = new Date(millis)
      return (
        date.getFullYear() + '-' + pad2(date.getMonth() + 1) + '-' + pad2(date.getDate())
        + ' ' + pad2(date.getHours()) + ':' + pad2(date.getMinutes())
      )
    }

    function relativeLabel(millis) {
      if (typeof millis !== 'number' || millis <= 0) return '—'
      var delta = Date.now() - millis
      if (delta < 5000) return '刚刚'
      if (delta < 60000) return Math.round(delta / 1000) + ' 秒前'
      if (delta < 3600000) return Math.round(delta / 60000) + ' 分钟前'
      if (delta < 86400000) return Math.round(delta / 3600000) + ' 小时前'
      return Math.round(delta / 86400000) + ' 天前'
    }

    function bytesLabel(value) {
      if (typeof value !== 'number' || value <= 0) return '—'
      if (value < 1024) return value + ' B'
      if (value < 1024 * 1024) return (value / 1024).toFixed(1) + ' KB'
      return (value / 1024 / 1024).toFixed(1) + ' MB'
    }

    function escapeHtml(text) {
      return String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
    }

    function unescapeAttr(text) {
      return String(text)
        .replace(/&quot;/g, '"')
        .replace(/&gt;/g, '>')
        .replace(/&lt;/g, '<')
        .replace(/&amp;/g, '&')
    }

    function slugify(text) {
      var plain = String(text).replace(/<[^>]*>/g, '').trim().toLowerCase()
      var slug = plain.replace(/[^\w\u3400-\u9fff-]+/g, '-').replace(/^-+|-+$/g, '')
      return 'kb-h-' + (slug === '' ? 'section' : slug).slice(0, 60)
    }

    function joinPath(dir, target) {
      var decoded = String(target)
      try {
        decoded = decodeURI(decoded)
      } catch (error) {
        // 保持原样
      }
      var absolute = decoded.charAt(0) === '/'
      var base = absolute || !dir ? [] : String(dir).split('/')
      var parts = decoded.split('/')
      var out = base.filter(function (part) {
        return part !== '' && part !== '.'
      })
      for (var index = 0; index < parts.length; index += 1) {
        var part = parts[index]
        if (part === '' || part === '.') continue
        if (part === '..') out.pop()
        else out.push(part)
      }
      return out.join('/')
    }

    function assetUrl(dir, target) {
      return API + '/asset?path=' + encodeURIComponent(joinPath(dir, target))
    }

    function baseName(relPath) {
      var parts = String(relPath).split('/')
      return parts[parts.length - 1]
    }

    function stemOf(relPath) {
      return baseName(relPath).replace(/\.(md|markdown|mdx)$/i, '')
    }

    function copyText(text) {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        return navigator.clipboard.writeText(text)
      }
      try {
        var area = document.createElement('textarea')
        area.value = text
        area.style.position = 'fixed'
        area.style.opacity = '0'
        document.body.appendChild(area)
        area.select()
        document.execCommand('copy')
        document.body.removeChild(area)
      } catch (error) {
        // 忽略
      }
      return Promise.resolve()
    }

    // ---- Markdown 渲染（够用就好：标题 / 列表 / 表格 / 代码 / 引用 / 链接 / 图片） ----

    function renderInline(text, dir) {
      var source = escapeHtml(text)
      source = source.replace(/`([^`]+)`/g, function (_, code) {
        return '<code class="dshkb-code">' + code + '</code>'
      })
      source = source.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+&quot;[^&]*&quot;)?\)/g, function (_, alt, url) {
        return '<img class="dshkb-img" alt="' + alt + '" loading="lazy" src="' + assetUrl(dir, unescapeAttr(url)) + '"/>'
      })
      source = source.replace(/\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|([^\]]+))?\]\]/g, function (_, target, label) {
        var name = unescapeAttr(target).trim()
        return '<a class="dshkb-link dshkb-link--wiki" data-kb-wiki="' + escapeHtml(name) + '">' + (label || name) + '</a>'
      })
      source = source.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+&quot;[^&]*&quot;)?\)/g, function (_, label, url) {
        var href = unescapeAttr(url)
        if (/^[a-z][a-z0-9+.-]*:/i.test(href)) {
          return '<a class="dshkb-link" href="' + escapeHtml(href) + '" target="_blank" rel="noreferrer noopener">' + label + '</a>'
        }
        if (/\.mdx?(#[^)]*)?$/i.test(href)) {
          return '<a class="dshkb-link" data-kb-path="' + escapeHtml(href.replace(/#.*$/, '')) + '">' + label + '</a>'
        }
        if (/^#/.test(href)) return '<a class="dshkb-link" href="' + escapeHtml(href) + '">' + label + '</a>'
        return '<a class="dshkb-link" href="' + escapeHtml(href) + '" target="_blank" rel="noreferrer noopener">' + label + '</a>'
      })
      source = source.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      source = source.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
      source = source.replace(/~~([^~]+)~~/g, '<del>$1</del>')
      return source
    }

    function splitTableRow(line) {
      var trimmed = line.trim()
      if (trimmed.charAt(0) === '|') trimmed = trimmed.slice(1)
      if (trimmed.charAt(trimmed.length - 1) === '|') trimmed = trimmed.slice(0, -1)
      return trimmed.split('|').map(function (cell) {
        return cell.trim()
      })
    }

    function renderMarkdown(source, dir) {
      var lines = String(source).split(/\r?\n/)
      var html = []
      var index = 0
      while (index < lines.length) {
        var line = lines[index]

        var fence = /^\s*```+\s*([\w+-]*)\s*$/.exec(line)
        if (fence !== null) {
          var code = []
          index += 1
          while (index < lines.length && !/^\s*```+\s*$/.test(lines[index])) {
            code.push(lines[index])
            index += 1
          }
          index += 1
          html.push(
            '<pre class="dshkb-pre"><code>' + escapeHtml(code.join('\n')) + '</code></pre>'
          )
          continue
        }

        if (/^\s*$/.test(line)) {
          index += 1
          continue
        }

        var heading = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line)
        if (heading !== null) {
          var level = heading[1].length
          var headingText = heading[2]
          html.push(
            '<h' + level + ' id="' + slugify(headingText) + '" class="dshkb-h dshkb-h--' + level + '">'
            + renderInline(headingText, dir) + '</h' + level + '>'
          )
          index += 1
          continue
        }

        if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
          html.push('<hr class="dshkb-hr"/>')
          index += 1
          continue
        }

        if (/^\s*>/.test(line)) {
          var quoted = []
          while (index < lines.length && /^\s*>/.test(lines[index])) {
            quoted.push(lines[index].replace(/^\s*>\s?/, ''))
            index += 1
          }
          html.push('<blockquote class="dshkb-quote">' + renderMarkdown(quoted.join('\n'), dir) + '</blockquote>')
          continue
        }

        if (line.indexOf('|') >= 0 && index + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[index + 1])) {
          var header = splitTableRow(line)
          var align = splitTableRow(lines[index + 1]).map(function (cell) {
            if (/^:-+:$/.test(cell)) return 'center'
            if (/^:-+$/.test(cell)) return 'left'
            if (/^-+:$/.test(cell)) return 'right'
            return ''
          })
          index += 2
          var rows = []
          while (index < lines.length && lines[index].indexOf('|') >= 0 && !/^\s*$/.test(lines[index])) {
            rows.push(splitTableRow(lines[index]))
            index += 1
          }
          html.push(
            '<div class="dshkb-table-wrap"><table class="dshkb-table"><thead><tr>'
            + header.map(function (cell, cellIndex) {
              return '<th' + (align[cellIndex] ? ' style="text-align:' + align[cellIndex] + '"' : '') + '>'
                + renderInline(cell, dir) + '</th>'
            }).join('')
            + '</tr></thead><tbody>'
            + rows.map(function (row) {
              return '<tr>' + row.map(function (cell, cellIndex) {
                return '<td' + (align[cellIndex] ? ' style="text-align:' + align[cellIndex] + '"' : '') + '>'
                  + renderInline(cell, dir) + '</td>'
              }).join('') + '</tr>'
            }).join('')
            + '</tbody></table></div>'
          )
          continue
        }

        if (/^\s*(?:[-*+]|\d+[.)])\s+/.test(line)) {
          var ordered = /^\s*\d+[.)]\s+/.test(line)
          var items = []
          while (index < lines.length) {
            var itemMatch = /^\s*(?:[-*+]|\d+[.)])\s+(.*)$/.exec(lines[index])
            if (itemMatch !== null) {
              items.push(itemMatch[1])
              index += 1
              continue
            }
            if (items.length > 0 && /^\s{2,}\S/.test(lines[index])) {
              items[items.length - 1] += ' ' + lines[index].trim()
              index += 1
              continue
            }
            break
          }
          html.push(
            '<' + (ordered ? 'ol' : 'ul') + ' class="dshkb-list">'
            + items.map(function (item) {
              var task = /^\[([ xX])\]\s*(.*)$/.exec(item)
              if (task !== null) {
                var checked = task[1] !== ' '
                return '<li class="dshkb-task"><span class="dshkb-check' + (checked ? ' dshkb-check--on' : '')
                  + '"></span><span>' + renderInline(task[2], dir) + '</span></li>'
              }
              return '<li>' + renderInline(item, dir) + '</li>'
            }).join('')
            + '</' + (ordered ? 'ol' : 'ul') + '>'
          )
          continue
        }

        var paragraph = []
        while (index < lines.length) {
          var current = lines[index]
          if (/^\s*$/.test(current)) break
          if (/^\s*(?:#{1,6}\s|```|>|[-*+]\s|\d+[.)]\s)/.test(current)) break
          if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(current)) break
          if (current.indexOf('|') >= 0 && index + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[index + 1])) break
          paragraph.push(current)
          index += 1
        }
        if (paragraph.length === 0) {
          index += 1
          continue
        }
        html.push('<p class="dshkb-p">' + renderInline(paragraph.join('\n'), dir) + '</p>')
      }
      return html.join('\n')
    }

    function collectOutline(source) {
      var outline = []
      var lines = String(source).split(/\r?\n/)
      var inFence = false
      for (var index = 0; index < lines.length; index += 1) {
        var line = lines[index]
        if (/^\s*```/.test(line)) {
          inFence = !inFence
          continue
        }
        if (inFence) continue
        var match = /^(#{1,4})\s+(.*?)\s*#*\s*$/.exec(line)
        if (match === null) continue
        outline.push({ level: match[1].length, text: match[2], id: slugify(match[2]) })
      }
      return outline
    }

    // ---- 样式 -------------------------------------------------------------

    var STYLE_TEXT = [
      '.dshkb{position:relative;display:flex;flex-direction:column;height:100%;min-height:0;width:100%;overflow:hidden;container-type:inline-size;',
      '.dshkb-modal{position:absolute;inset:0;z-index:40;display:flex;align-items:center;justify-content:center;padding:16px;background:rgba(15,17,22,.42)}',
      '.dshkb-modal-card{width:min(440px,100%);max-height:100%;display:flex;flex-direction:column;gap:8px;padding:14px;border-radius:12px;background:var(--dsw-alias-bg-base,#fff);border:1px solid var(--dsw-alias-border-l1,#e5e6eb);box-shadow:0 18px 44px rgba(0,0,0,.28)}',
      '.dshkb-modal-head{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary,#1b1d22)}',
      '.dshkb-modal-sub{font-size:11px;line-height:1.6;color:var(--dsw-alias-label-tertiary,#8b8f98)}',
      '.dshkb-modal-list{display:flex;flex-direction:column;gap:6px;overflow:auto;min-height:0}',
      '.dshkb-modal-empty{font-size:12px;color:var(--dsw-alias-label-tertiary,#8b8f98);padding:8px 0}',
      '.dshkb-ws{display:flex;flex-direction:column;gap:2px;align-items:flex-start;padding:8px 10px;border-radius:9px;border:1px solid var(--dsw-alias-border-l2,#d9dbe1);background:var(--dsw-alias-bg-layer-1,#fafafa);cursor:pointer;text-align:left;font:inherit}',
      '.dshkb-ws:hover{background:var(--dsw-alias-interactive-bg-hover,#f0f1f4);border-color:var(--dsw-alias-brand-primary,#3b6cff)}',
      '.dshkb-ws--current{border-color:var(--dsw-alias-brand-primary,#3b6cff);background:var(--dsw-alias-accent-soft,#eef2ff)}',
      '.dshkb-ws-title{font-size:12px;font-weight:600;color:var(--dsw-alias-label-primary,#1b1d22)}',
      '.dshkb-ws-meta{font-size:10.5px;color:var(--dsw-alias-label-tertiary,#8b8f98);word-break:break-all}',
      '.dshkb-modal-foot{display:flex;justify-content:flex-end;gap:8px;padding-top:2px}',
      'font:13px/1.65 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;',
      'color:var(--dsw-alias-label-primary,#1f2328);background:var(--dsw-alias-bg-base,#fff);}',
      '.dshkb *{box-sizing:border-box}',
      '.dshkb-topbar{display:flex;align-items:center;gap:8px;padding:0 8px;min-height:34px;flex:0 0 auto;',
      'border-bottom:1px solid var(--dsw-alias-border-l1,#eceef2);background:var(--dsw-alias-bg-layer-1,#fafafa)}',
      '.dshkb-spacer{flex:1;min-width:0}',
      '.dshkb-toggle{border:1px solid var(--dsw-alias-border-l1,#e5e6eb);background:transparent;cursor:pointer;',
      'font:inherit;font-size:11px;padding:2px 9px;border-radius:999px;color:var(--dsw-alias-label-secondary,#5b6472);white-space:nowrap}',
      '.dshkb-toggle:hover{border-color:var(--dsw-alias-border-l2,#c9cdd6);color:var(--dsw-alias-label-primary,#1f2328)}',
      '.dshkb-topbar-title{font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary,#5b6472);',
      'overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dshkb-side{display:flex;flex-direction:column;min-height:0;flex:0 0 auto;max-height:44%;',
      'border-bottom:1px solid var(--dsw-alias-border-l1,#e5e6eb);background:var(--dsw-alias-bg-layer-1,#fafafa)}',
      '.dshkb--collapsed .dshkb-side{display:none}',
      // 尺寸容器只能影响子孙，所以换向放在内层 .dshkb-inner 上
      '.dshkb-inner{display:flex;flex-direction:column;flex:1 1 auto;min-height:0;overflow:hidden}',
      '@container (min-width:720px){.dshkb-inner{flex-direction:row}.dshkb-side{flex:0 0 292px;width:292px;max-height:none;',
      'border-right:1px solid var(--dsw-alias-border-l1,#e5e6eb);border-bottom:0}}',
      '.dshkb-side-head{padding:10px 10px 6px;display:flex;flex-direction:column;gap:6px;',
      'border-bottom:1px solid var(--dsw-alias-border-l1,#eceef2)}',
      '.dshkb-search{display:flex;align-items:center;gap:6px;padding:5px 8px;border-radius:8px;',
      'background:var(--dsw-alias-bg-base,#fff);border:1px solid var(--dsw-alias-border-l2,#d8dbe2);}',
      '.dshkb-search input{flex:1;min-width:0;border:0;outline:0;background:transparent;color:inherit;font:inherit}',
      '.dshkb-search input::placeholder{color:var(--dsw-alias-label-tertiary,#9aa0aa)}',
      '.dshkb-tabs{display:flex;gap:4px;flex-wrap:wrap}',
      '.dshkb-tab{border:0;cursor:pointer;font:inherit;font-size:12px;padding:3px 9px;border-radius:999px;',
      'background:transparent;color:var(--dsw-alias-label-secondary,#5b6472)}',
      '.dshkb-tab:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.05))}',
      '.dshkb-tab--on{background:var(--dsw-alias-bg-layer-3,rgba(0,0,0,.08));color:var(--dsw-alias-label-primary,#1f2328);font-weight:600}',
      '.dshkb-chips{display:flex;gap:4px;flex-wrap:wrap;padding:0 10px 8px}',
      '.dshkb-chip{border:1px solid var(--dsw-alias-border-l1,#e5e6eb);cursor:pointer;font:inherit;font-size:11px;',
      'padding:2px 7px;border-radius:999px;background:transparent;color:var(--dsw-alias-label-secondary,#5b6472)}',
      '.dshkb-chip:hover{border-color:var(--dsw-alias-border-l2,#c9cdd6)}',
      '.dshkb-chip--on{border-color:var(--dsw-alias-brand-primary,#3b6cff);color:var(--dsw-alias-brand-primary,#3b6cff);',
      'background:var(--dsw-alias-accent-soft,rgba(59,108,255,.08))}',
      '.dshkb-scroll{flex:1;min-height:0;overflow:auto;padding:6px 6px 18px}',
      '.dshkb-dir{display:flex;align-items:center;gap:5px;padding:4px 6px;border-radius:6px;cursor:pointer;',
      'color:var(--dsw-alias-label-secondary,#5b6472);font-size:12px;font-weight:600}',
      '.dshkb-dir:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.05))}',
      '.dshkb-caret{display:inline-block;width:10px;text-align:center;transition:transform .12s ease;',
      'color:var(--dsw-alias-label-tertiary,#9aa0aa)}',
      '.dshkb-caret--open{transform:rotate(90deg)}',
      '.dshkb-count{margin-left:auto;font-weight:400;font-size:11px;color:var(--dsw-alias-label-tertiary,#9aa0aa)}',
      '.dshkb-file{display:flex;flex-direction:column;gap:1px;padding:5px 8px;border-radius:6px;cursor:pointer;',
      'border-left:2px solid transparent}',
      '.dshkb-file:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.05))}',
      '.dshkb-file--on{background:var(--dsw-alias-interactive-bg-active,rgba(59,108,255,.12));',
      'border-left-color:var(--dsw-alias-brand-primary,#3b6cff)}',
      '.dshkb-file-title{display:flex;align-items:center;gap:5px;min-width:0}',
      '.dshkb-file-title span:first-child{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dshkb-file-sub{font-size:11px;color:var(--dsw-alias-label-tertiary,#9aa0aa);overflow:hidden;',
      'text-overflow:ellipsis;white-space:nowrap}',
      '.dshkb-dot{flex:0 0 auto;width:5px;height:5px;border-radius:50%;background:var(--dsw-alias-label-tertiary,#9aa0aa)}',
      '.dshkb-main{flex:1;min-width:0;display:flex;flex-direction:column;min-height:0;overflow:hidden}',
      '.dshkb-top{display:flex;align-items:center;gap:8px;padding:10px 16px;min-height:48px;',
      'border-bottom:1px solid var(--dsw-alias-border-l1,#eceef2);background:var(--dsw-alias-bg-base,#fff)}',
      '.dshkb-top h2{margin:0;font-size:15px;font-weight:650;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dshkb-top-actions{margin-left:auto;display:flex;align-items:center;gap:6px;flex:0 0 auto}',
      '.dshkb-btn{border:1px solid var(--dsw-alias-border-l2,#d8dbe2);background:var(--dsw-alias-bg-base,#fff);',
      'color:var(--dsw-alias-label-primary,#1f2328);font:inherit;font-size:12px;padding:4px 10px;border-radius:7px;cursor:pointer;',
      'white-space:nowrap}',
      '.dshkb-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.05))}',
      '.dshkb-btn--primary{background:var(--dsw-alias-button-primary-fill,#3b6cff);border-color:transparent;color:#fff}',
      '.dshkb-btn--primary:hover{filter:brightness(1.06);background:var(--dsw-alias-button-primary-fill,#3b6cff)}',
      '.dshkb-btn:disabled{opacity:.5;cursor:default}',
      '.dshkb-body{flex:1;min-height:0;overflow:auto;padding:18px 26px 40px}',
      '.dshkb-doc{max-width:880px;margin:0 auto}',
      '.dshkb-badges{display:flex;flex-wrap:wrap;gap:5px;margin:0 0 14px}',
      '.dshkb-badge{font-size:11px;padding:1px 8px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1,#e5e6eb);',
      'color:var(--dsw-alias-label-secondary,#5b6472);background:var(--dsw-alias-bg-layer-1,#f7f8fa)}',
      '.dshkb-badge--info{border-color:#7aa7ff;color:#2f5bd0;background:rgba(59,108,255,.08)}',
      '.dshkb-badge--ok{border-color:#63c08a;color:#1f7a4a;background:rgba(52,168,106,.1)}',
      '.dshkb-badge--warn{border-color:#e0b04a;color:#8a5b00;background:rgba(224,176,74,.12)}',
      '.dshkb-badge--brand{border-color:#b58cff;color:#5b34b5;background:rgba(140,92,255,.1)}',
      '.dshkb-warnbox{margin:0 0 14px;padding:8px 12px;border-radius:8px;font-size:12px;',
      'background:rgba(224,176,74,.12);border:1px solid rgba(224,176,74,.5);color:#8a5b00}',
      '.dshkb-outline{margin:0 0 16px;padding:8px 12px;border-radius:8px;font-size:12px;',
      'background:var(--dsw-alias-bg-layer-1,#f7f8fa);border:1px solid var(--dsw-alias-border-l1,#eceef2)}',
      '.dshkb-outline summary{cursor:pointer;color:var(--dsw-alias-label-secondary,#5b6472);font-weight:600}',
      '.dshkb-outline ol{margin:6px 0 0;padding-left:18px}',
      '.dshkb-outline a{color:var(--dsw-alias-brand-primary,#3b6cff);text-decoration:none;cursor:pointer}',
      '.dshkb-outline li.lv3{margin-left:12px}.dshkb-outline li.lv4{margin-left:24px}',
      '.dshkb-h{margin:20px 0 10px;line-height:1.35;scroll-margin-top:12px}',
      '.dshkb-h--1{font-size:21px;font-weight:700;margin-top:4px}',
      '.dshkb-h--2{font-size:17px;font-weight:680;padding-bottom:4px;border-bottom:1px solid var(--dsw-alias-border-l1,#eceef2)}',
      '.dshkb-h--3{font-size:15px;font-weight:650}',
      '.dshkb-h--4,.dshkb-h--5,.dshkb-h--6{font-size:13.5px;font-weight:650}',
      '.dshkb-p{margin:9px 0;white-space:pre-wrap;word-break:break-word}',
      '.dshkb-list{margin:8px 0;padding-left:22px}.dshkb-list li{margin:3px 0}',
      '.dshkb-task{list-style:none;margin-left:-18px;display:flex;gap:6px;align-items:flex-start}',
      '.dshkb-check{flex:0 0 auto;width:12px;height:12px;margin-top:3px;border-radius:3px;',
      'border:1px solid var(--dsw-alias-border-l2,#c9cdd6);display:inline-block}',
      '.dshkb-check--on{background:var(--dsw-alias-brand-primary,#3b6cff);border-color:transparent}',
      '.dshkb-code{padding:1px 5px;border-radius:4px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;',
      'font-size:12px;background:var(--dsw-alias-bg-layer-2,#f0f1f5)}',
      '.dshkb-pre{margin:10px 0;padding:12px 14px;border-radius:9px;overflow:auto;',
      'background:var(--dsw-alias-bg-layer-2,#f4f5f8);border:1px solid var(--dsw-alias-border-l1,#e8e9ee)}',
      '.dshkb-pre code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;',
      'white-space:pre;color:var(--dsw-alias-label-primary,#1f2328)}',
      '.dshkb-quote{margin:10px 0;padding:6px 14px;border-left:3px solid var(--dsw-alias-border-l2,#d8dbe2);',
      'color:var(--dsw-alias-label-secondary,#5b6472)}',
      '.dshkb-table-wrap{overflow:auto;margin:12px 0}',
      '.dshkb-table{border-collapse:collapse;width:100%;font-size:12.5px}',
      '.dshkb-table th,.dshkb-table td{border:1px solid var(--dsw-alias-border-l1,#e5e6eb);padding:6px 10px;',
      'text-align:left;vertical-align:top}',
      '.dshkb-table thead th{background:var(--dsw-alias-bg-layer-1,#f7f8fa);font-weight:650}',
      '.dshkb-hr{border:0;border-top:1px solid var(--dsw-alias-border-l1,#eceef2);margin:18px 0}',
      '.dshkb-link{color:var(--dsw-alias-brand-primary,#3b6cff);text-decoration:none;cursor:pointer;',
      'border-bottom:1px solid transparent}',
      '.dshkb-link:hover{border-bottom-color:currentColor}',
      '.dshkb-link--wiki{border-bottom-style:dashed;border-bottom-color:rgba(59,108,255,.5)}',
      '.dshkb-img{max-width:100%;border-radius:8px;display:block;margin:10px 0;',
      'border:1px solid var(--dsw-alias-border-l1,#eceef2)}',
      '.dshkb-links{margin:26px 0 0;padding-top:12px;border-top:1px solid var(--dsw-alias-border-l1,#eceef2);',
      'display:flex;flex-direction:column;gap:10px;font-size:12px}',
      '.dshkb-links h4{margin:0 0 4px;font-size:12px;font-weight:650;color:var(--dsw-alias-label-secondary,#5b6472)}',
      '.dshkb-links ul{margin:0;padding-left:16px}',
      '.dshkb-links a{cursor:pointer;color:var(--dsw-alias-brand-primary,#3b6cff);text-decoration:none}',
      '.dshkb-empty{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;',
      'padding:40px;text-align:center;color:var(--dsw-alias-label-tertiary,#9aa0aa)}',
      '.dshkb-empty strong{color:var(--dsw-alias-label-primary,#1f2328);font-size:15px}',
      '.dshkb-empty kbd{font-family:inherit;font-size:11px;padding:1px 6px;border-radius:5px;',
      'border:1px solid var(--dsw-alias-border-l2,#d8dbe2);background:var(--dsw-alias-bg-layer-1,#f7f8fa)}',
      '.dshkb-result{padding:7px 9px;border-radius:7px;cursor:pointer;border-left:2px solid transparent}',
      '.dshkb-result:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.05))}',
      '.dshkb-result--on{background:var(--dsw-alias-interactive-bg-active,rgba(59,108,255,.12));border-left-color:var(--dsw-alias-brand-primary,#3b6cff)}',
      '.dshkb-result-title{font-size:12.5px;display:flex;gap:5px;align-items:center}',
      '.dshkb-result-path{font-size:10.5px;color:var(--dsw-alias-label-tertiary,#9aa0aa);overflow:hidden;',
      'text-overflow:ellipsis;white-space:nowrap}',
      '.dshkb-result-line{font-size:11px;color:var(--dsw-alias-label-secondary,#5b6472);',
      'font-family:ui-monospace,Menlo,Consolas,monospace;margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dshkb-result-line em{color:var(--dsw-alias-state-warn-primary,#b26a00);font-style:normal;font-weight:600}',
      '.dshkb-foot{display:flex;align-items:center;gap:8px;padding:6px 12px;font-size:11px;',
      'color:var(--dsw-alias-label-tertiary,#9aa0aa);border-top:1px solid var(--dsw-alias-border-l1,#eceef2)}',
      '.dshkb-live{display:inline-flex;align-items:center;gap:5px}',
      '.dshkb-live i{width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-label-tertiary,#9aa0aa);display:inline-block}',
      '.dshkb-live--on i{background:var(--dsw-alias-state-success-primary,#2f9e5f);box-shadow:0 0 0 3px rgba(47,158,95,.16)}',
      '.dshkb-toast{position:fixed;right:18px;bottom:18px;z-index:60;max-width:360px;padding:9px 13px;border-radius:9px;',
      'font-size:12px;background:var(--dsw-alias-bg-layer-3,#24272e);color:#fff;box-shadow:0 8px 24px rgba(0,0,0,.24)}',
      '.dshkb-selectbar{position:fixed;z-index:70;display:flex;gap:4px;padding:4px;border-radius:8px;',
      'background:#24272e;color:#fff;box-shadow:0 8px 24px rgba(0,0,0,.35);border:1px solid rgba(255,255,255,.12)}',
      '.dshkb-selectbar button{border:0;background:transparent;color:#fff;font:inherit;font-size:12px;',
      'padding:3px 8px;border-radius:6px;cursor:pointer;white-space:nowrap}',
      '.dshkb-selectbar button:hover{background:rgba(255,255,255,.16)}',
      '.dshkb-ask{display:flex;gap:6px;padding:10px 26px 14px;border-top:1px solid var(--dsw-alias-border-l1,#eceef2);',
      'background:var(--dsw-alias-bg-base,#fff)}',
      '.dshkb-ask input{flex:1;min-width:0;border:1px solid var(--dsw-alias-border-l2,#d8dbe2);border-radius:8px;',
      'padding:7px 10px;font:inherit;background:var(--dsw-alias-bg-base,#fff);color:inherit;outline:0}',
      '.dshkb-ask input:focus{border-color:var(--dsw-alias-brand-primary,#3b6cff)}',
      '.dshkb-meta{font-size:11px;color:var(--dsw-alias-label-tertiary,#9aa0aa);display:flex;gap:10px;flex-wrap:wrap;margin:0 0 12px}',
      '.dshkb-loading{padding:14px;font-size:12px;color:var(--dsw-alias-label-tertiary,#9aa0aa)}',
      '.dshkb-err{padding:10px 12px;margin:8px;border-radius:8px;font-size:12px;',
      'background:rgba(220,80,80,.1);border:1px solid rgba(220,80,80,.4);color:#b02a2a}',
    ].join('')

    function ensureStyles() {
      if (document.getElementById(STYLE_ID) !== null) return
      var style = document.createElement('style')
      style.id = STYLE_ID
      style.textContent = STYLE_TEXT
      document.head.appendChild(style)
    }

    function readStars() {
      try {
        var raw = window.localStorage.getItem(STAR_KEY)
        if (raw === null) return []
        var parsed = JSON.parse(raw)
        return Array.isArray(parsed) ? parsed : []
      } catch (error) {
        return []
      }
    }

    function writeStars(list) {
      try {
        window.localStorage.setItem(STAR_KEY, JSON.stringify(list))
      } catch (error) {
        // localStorage 不可用时忽略
      }
    }


    function readSideCollapsed() {
      try {
        return window.localStorage.getItem(SIDE_KEY) === '1'
      } catch (error) {
        return false
      }
    }

    function writeSideCollapsed(value) {
      try {
        window.localStorage.setItem(SIDE_KEY, value === true ? '1' : '0')
      } catch (error) {
        // 忽略
      }
    }

    // 打开右栏知识库页（标题栏按钮 / 快捷键 / 其它入口共用）
    function openKbTab() {
      var right = services.sidebarRight
      if (right === null || right === undefined) {
        window.console.warn('[dsh-md-panel] sidebarRight 服务不可用，打不开右栏面板')
        return false
      }
      try {
        right.openTab(KB_KIND)
        return true
      } catch (error) {
        window.console.warn('[dsh-md-panel] 打开右栏失败', error)
        return false
      }
    }

    // 会话输入栏桥：inputActions 只发给会话作用域 slot 的占据者，
    // 右栏面板拿不到，所以在输入栏左侧挂一个不渲染的组件把它存下来。
    var composerBridge = { actions: null, sessionId: null }

    function KbComposerBridge(props) {
      composerBridge.actions = (props && props.inputActions) || null
      composerBridge.sessionId = (props && props.sessionId) || null
      return null
    }

    // 把文字追加进当前会话的输入栏（不覆盖已经打的字）。
    function insertIntoComposer(text) {
      var actions = composerBridge.actions
      if (actions === null || actions === undefined) return false
      try {
        if (typeof actions.captureInsertion === 'function' && typeof actions.insertText === 'function') {
          var span = actions.captureInsertion()
          if (actions.insertText(text, span) !== false) return true
        }
      } catch (error) {
        window.console.warn('[dsh-md-panel] 插入引用失败', error)
      }
      return false
    }

    // ---- 图标 -------------------------------------------------------------

    function BookIcon(props) {
      var size = (props && props.size) || 18
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.7,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
        },
        h('path', { d: 'M4 5.5A2.5 2.5 0 0 1 6.5 3H19v16.5H6.5A2.5 2.5 0 0 0 4 22V5.5z' }),
        h('path', { d: 'M4 19.5V20a2 2 0 0 0 2.5 2H19' }),
        h('path', { d: 'M8.5 7.5h7M8.5 11h5' })
      )
    }

    // ---- 主面板 -----------------------------------------------------------

    function KbPanel(props) {
      ensureStyles()

      var [tree, setTree] = useState(null)
      var [treeError, setTreeError] = useState('')
      var [mode, setMode] = useState('tree')
      var [query, setQuery] = useState('')
      var [results, setResults] = useState(null)
      var [searching, setSearching] = useState(false)
      var [typeFilter, setTypeFilter] = useState('')
      var [tagFilter, setTagFilter] = useState('')
      var [selectedPath, setSelectedPath] = useState('')
      var [doc, setDoc] = useState(null)
      var [docLoading, setDocLoading] = useState(false)
      var [docError, setDocError] = useState('')
      var [expanded, setExpanded] = useState(function () {
        return {}
      })
      var [connected, setConnected] = useState(false)
      var [lastSync, setLastSync] = useState(null)
      var [toast, setToast] = useState(null)
      var [stars, setStars] = useState(readStars)
      var [selection, setSelection] = useState(null)
      var [askText, setAskText] = useState('')
      var [wsPrompt, setWsPrompt] = useState(null)
      var [recent, setRecent] = useState(null)
      var [sideCollapsed, setSideCollapsed] = useState(readSideCollapsed)

      var docRef = useRef(null)
      var toastTimer = useRef(null)
      var searchTimer = useRef(null)
      var docPathRef = useRef('')
      var docMtimeRef = useRef(0)
      var wikiIndexRef = useRef({})

      docPathRef.current = selectedPath

      var showToast = useCallback(function (text) {
        setToast({ text: text, key: Date.now() })
        if (toastTimer.current !== null) clearTimeout(toastTimer.current)
        toastTimer.current = setTimeout(function () {
          setToast(null)
        }, 2600)
      }, [])

      useEffect(function () {
        return function () {
          if (toastTimer.current !== null) clearTimeout(toastTimer.current)
          if (searchTimer.current !== null) clearTimeout(searchTimer.current)
        }
      }, [])

      // 选中正文 → 浮动条
      useEffect(function () {
        function handleSelectionMouseUp() {
          var body = document.querySelector('.dshkb-body')
          if (body === null) return
          var sel = window.getSelection()
          if (sel === null || sel.isCollapsed === true || sel.rangeCount === 0) return
          var text = String(sel.toString() || '').trim()
          if (text.length < 2) return
          var range = sel.getRangeAt(0)
          var node = range.commonAncestorContainer
          var element = node.nodeType === 1 ? node : node.parentElement
          if (element === null || body.contains(element) !== true) return
          var rect = range.getBoundingClientRect()
          if (rect.width === 0 && rect.height === 0) return
          setSelection({
            text: text.slice(0, 2000),
            x: Math.max(140, Math.min(window.innerWidth - 140, rect.left + rect.width / 2)),
            y: Math.max(52, rect.top - 44),
          })
        }
        document.addEventListener('mouseup', handleSelectionMouseUp)
        return function () {
          document.removeEventListener('mouseup', handleSelectionMouseUp)
        }
      }, [])

      // 知识库 → 树
      var loadTree = useCallback(function () {
        return apiGet('/tree')
          .then(function (payload) {
            setTree(payload)
            setTreeError('')
            var index = {}
            for (var i = 0; i < payload.files.length; i += 1) {
              var file = payload.files[i]
              index[file.stem] = file.path
              index[file.path] = file.path
              index[file.path.replace(/\.(md|markdown|mdx)$/i, '')] = file.path
            }
            wikiIndexRef.current = index
            return payload
          })
          .catch(function (error) {
            setTreeError(error.message || String(error))
            return null
          })
      }, [])

      useEffect(function () {
        loadTree()
      }, [loadTree])

      // 实时同步：SSE
      useEffect(function () {
        var source = null
        var disposed = false
        var retry = null

        function connect() {
          if (disposed) return
          try {
            source = new EventSource(API + '/events')
          } catch (error) {
            retry = setTimeout(connect, 3000)
            return
          }
          source.onopen = function () {
            setConnected(true)
          }
          source.onmessage = function (event) {
            setConnected(true)
            var payload = null
            try {
              payload = JSON.parse(event.data)
            } catch (error) {
              return
            }
            if (payload === null) return
            if (payload.type === 'change') {
              setLastSync({ at: payload.at, added: payload.added, changed: payload.changed, removed: payload.removed })
              loadTree().then(function (next) {
                if (next === null) return
                var currentPath = docPathRef.current
                if (currentPath === '') return
                var entry = null
                for (var i = 0; i < next.files.length; i += 1) {
                  if (next.files[i].path === currentPath) {
                    entry = next.files[i]
                    break
                  }
                }
                if (entry === undefined) {
                  setDoc(null)
                  docMtimeRef.current = 0
                  setSelectedPath('')
                  showToast('当前文档已从知识库移除')
                  return
                }
                if (entry.mtime === docMtimeRef.current) return
                apiGet('/file?path=' + encodeURIComponent(currentPath))
                  .then(function (fresh) {
                    setDoc(fresh)
                    docMtimeRef.current = fresh.mtime
                    showToast('当前文档已随磁盘更新')
                  })
                  .catch(function () {})
              })
            }
          }
          source.onerror = function () {
            setConnected(false)
            if (source !== null) {
              source.close()
              source = null
            }
            if (!disposed) retry = setTimeout(connect, 3000)
          }
        }

        connect()
        return function () {
          disposed = true
          if (retry !== null) clearTimeout(retry)
          if (source !== null) source.close()
        }
      }, [loadTree, showToast])

      // 打开文档
      var openFile = useCallback(function (relPath) {
        if (relPath === '' || relPath === undefined || relPath === null) return
        setSelectedPath(relPath)
        setDocLoading(true)
        setDocError('')
        setSelection(null)
        apiGet('/file?path=' + encodeURIComponent(relPath))
          .then(function (payload) {
            setDoc(payload)
            docMtimeRef.current = payload.mtime
            setDocLoading(false)
            var parts = relPath.split('/')
            parts.pop()
            setExpanded(function (previous) {
              var next = Object.assign({}, previous)
              var trail = []
              for (var i = 0; i < parts.length; i += 1) {
                trail.push(parts[i])
                next[trail.join('/')] = true
              }
              return next
            })
            requestAnimationFrame(function () {
              if (docRef.current !== null) docRef.current.scrollTop = 0
            })
          })
          .catch(function (error) {
            setDoc(null)
            setDocLoading(false)
            setDocError(error.message || String(error))
          })
      }, [])

      // 搜索（防抖）
      var runSearch = useCallback(function (text) {
        if (text.trim() === '') {
          setResults(null)
          return
        }
        setSearching(true)
        apiGet('/search?q=' + encodeURIComponent(text))
          .then(function (payload) {
            setResults(payload.hits)
            setSearching(false)
          })
          .catch(function (error) {
            setResults([])
            setSearching(false)
            showToast('搜索失败：' + (error.message || String(error)))
          })
      }, [showToast])

      useEffect(function () {
        if (searchTimer.current !== null) clearTimeout(searchTimer.current)
        if (mode !== 'search') return
        searchTimer.current = setTimeout(function () {
          runSearch(query)
        }, 260)
      }, [query, mode, runSearch])

      var loadRecent = useCallback(function () {
        apiGet('/timeline?limit=80')
          .then(function (payload) {
            setRecent(payload.files)
          })
          .catch(function () {
            setRecent([])
          })
      }, [])

      useEffect(function () {
        if (mode === 'recent' && recent === null) loadRecent()
      }, [mode, recent, loadRecent])

      // ---- 接入对话 -------------------------------------------------------

      function listWorkspaces() {
        var ws = services.workspaces
        if (ws === null || ws === undefined || ws.list === null || ws.list === undefined) return []
        try {
          var snapshot = ws.list.getSnapshot()
          if (snapshot === null || snapshot === undefined || !Array.isArray(snapshot.items)) return []
          return snapshot.items
        } catch (error) {
          window.console.warn('[dsh-md-panel] 读工作区列表失败', error)
          return []
        }
      }

      function currentWorkspaceId() {
        var sessionId = composerBridge.sessionId
        if (sessionId === null || sessionId === undefined) return undefined
        var items = listWorkspaces()
        for (var index = 0; index < items.length; index++) {
          var ids = items[index].sessionIds
          if (Array.isArray(ids) && ids.indexOf(sessionId) >= 0) return items[index].workspaceId
        }
        return undefined
      }

      // 建会话：先让 DSH 开新会话（不带 prompt），等新会话挂上来再往它的输入栏里写。
      // 不直接走 startSession(workspaceId, { prompt })：草稿初始化可能落在“当前仍保留的
      // 那个会话”上，实测会把问题写进旧会话的输入栏。
      function waitAndInsert(prompt, beforeSessionId) {
        var tries = 0
        var timer = window.setInterval(function () {
          tries += 1
          var now = composerBridge.sessionId
          var switched = now !== null && now !== undefined && now !== beforeSessionId
          if (switched && insertIntoComposer(prompt)) {
            window.clearInterval(timer)
            showToast('已在新会话里填好问题，改一句就能发')
            return
          }
          if (tries >= 40) {
            window.clearInterval(timer)
            copyText(prompt).then(function () {
              showToast('新会话没切过去，内容已复制到剪贴板')
            })
          }
        }, 150)
      }

      function startNewSession(workspaceId, prompt) {
        var workspace = services.uiWorkspace
        if (workspace === undefined || workspace === null || typeof workspace.startSession !== 'function') {
          copyText(prompt).then(function () {
            showToast('已复制到剪贴板（新会话接口不可用）')
          })
          return false
        }
        try {
          var before = composerBridge.sessionId
          workspace.startSession(workspaceId)
          waitAndInsert(prompt, before)
          return true
        } catch (error) {
          window.console.warn('[dsh-md-panel] 开新会话失败', error)
          copyText(prompt).then(function () {
            showToast('开新会话失败，已复制到剪贴板')
          })
          return false
        }
      }

      function confirmNewSession(workspaceId) {
        var prompt = wsPrompt
        setWsPrompt(null)
        if (prompt === null) return
        startNewSession(workspaceId, prompt)
      }

      function absolutePath(relPath) {
        var root = tree !== null && tree.root ? tree.root : ''
        return root === '' ? relPath : root.replace(/\/+$/, '') + '/' + relPath
      }

      // 默认所有提问都进「当前会话」的输入栏，不打断正在跑的对话。
      function deliverToComposer(text, okMessage) {
        if (insertIntoComposer(text)) {
          showToast(okMessage || '已放进当前会话的输入栏，接着问就行')
          return true
        }
        copyText(text).then(function () {
          showToast('输入栏没接上，内容已复制到剪贴板')
        })
        return false
      }

      function wholeDocPrompt() {
        return [
          '请解读知识库文档《' + doc.title + '》',
          '文件：' + absolutePath(doc.path),
          '',
          '请先读原文再回答：这篇文档在讲什么？有哪些半年后还要精确复现的关键事实（IP、端口、版本、路径、账号、参数）？有什么需要留意的前提或坑？',
        ].join('\n')
      }

      function docQuestionPrompt(question) {
        return [
          '知识库文档《' + doc.title + '》：' + absolutePath(doc.path),
          '',
          question,
        ].join('\n')
      }

      function selectionPrompt(kind) {
        var heading = { explain: '解释这段内容', follow: '基于这段继续分析', summarize: '总结这段' }[kind] || '解释这段内容'
        return [
          '知识库文档《' + doc.title + '》：' + absolutePath(doc.path),
          '',
          '请' + heading + '（在整篇文档的语境里）：',
          '',
          tidyBlock(selection.text),
        ].join('\n')
      }

      // 整篇「解读」→ 当前会话
      function askWholeDoc() {
        if (doc === null) return
        deliverToComposer(wholeDocPrompt(), '已把这篇的解读请求放进当前会话输入栏')
      }

      // 「引用」：把这篇文档的引用塞进当前会话的输入栏（不开新会话）。
      function referenceText() {
        return [
          '【引用】知识库文档《' + doc.title + '》(' + doc.path + ')',
          '文件：' + absolutePath(doc.path),
          '',
        ].join('\n')
      }

      function quoteToComposer() {
        if (doc === null) return
        deliverToComposer(referenceText(), '已把这篇的引用放进输入栏，接着说想问的')
      }

      function tidyBlock(text) {
        return String(text || '')
          .split('\n')
          .map(function (line) { return line.replace(/[ \t]+$/, '') })
          .join('\n')
          .replace(/\n{3,}/g, '\n\n')
          .trim()
      }

      function askSelection(kind) {
        if (selection === null || doc === null) return
        deliverToComposer(selectionPrompt(kind), '已把这段和问题放进当前会话输入栏')
        setSelection(null)
      }

      function askAboutDoc() {
        if (doc === null) return
        var question = askText.trim()
        if (question === '') {
          showToast('先写下想问的问题')
          return
        }
        deliverToComposer(docQuestionPrompt(question), '已把问题放进当前会话输入栏')
        setAskText('')
      }

      // 「新会话提问」：带着当前问题（没写就整篇解读）另开一个会话
      function askAboutDocNewSession() {
        if (doc === null) return
        var question = askText.trim()
        setWsPrompt(question === '' ? wholeDocPrompt() : docQuestionPrompt(question))
        setAskText('')
      }

      // ---- 文档操作 -------------------------------------------------------

      function toggleStar(relPath) {
        setStars(function (previous) {
          var next = previous.indexOf(relPath) >= 0
            ? previous.filter(function (item) {
              return item !== relPath
            })
            : previous.concat([relPath])
          writeStars(next)
          return next
        })
      }

      function revealInManager() {
        if (doc === null) return
        apiPost('/open', { path: doc.path, mode: 'reveal' })
          .then(function () {
            showToast('已在文件管理器里打开所在目录')
          })
          .catch(function (error) {
            showToast('打开失败：' + (error.message || String(error)))
          })
      }

      function copyPath() {
        if (doc === null) return
        copyText(absolutePath(doc.path)).then(function () {
          showToast('路径已复制')
        })
      }

      function copyWiki() {
        if (doc === null) return
        copyText('[[' + doc.path.replace(/\.(md|markdown|mdx)$/i, '') + ']]').then(function () {
          showToast('wiki 链接已复制')
        })
      }

      function manualRescan() {
        apiPost('/rescan', {})
          .then(function (payload) {
            setTree(payload)
            showToast('已重新扫描：' + payload.count + ' 篇')
            var current = docPathRef.current
            if (current !== '') openFile(current)
          })
          .catch(function (error) {
            showToast('扫描失败：' + (error.message || String(error)))
          })
      }

      // 选中文字 → 浮动操作条
      function handleMouseUp() {
        var current = window.getSelection()
        if (current === null || current.rangeCount === 0 || current.isCollapsed) {
          setSelection(null)
          return
        }
        var text = String(current.toString()).trim()
        if (text.length < 4) {
          setSelection(null)
          return
        }
        var range = current.getRangeAt(0)
        var rect = range.getBoundingClientRect()
        if (rect.width === 0 && rect.height === 0) {
          setSelection(null)
          return
        }
        setSelection({
          text: text.slice(0, 4000),
          x: Math.min(Math.max(rect.left + rect.width / 2, 120), window.innerWidth - 120),
          y: Math.max(rect.top - 44, 8),
        })
      }

      function handleDocClick(event) {
        var target = event.target
        if (!(target instanceof Element)) return
        var wiki = target.closest('[data-kb-wiki]')
        if (wiki !== null) {
          event.preventDefault()
          var name = unescapeAttr(wiki.getAttribute('data-kb-wiki') || '')
          var resolved = wikiIndexRef.current[name]
            || wikiIndexRef.current[name + '.md']
            || wikiIndexRef.current[joinPath(wikiDir(), name) + '.md']
          if (resolved !== undefined) openFile(resolved)
          else showToast('知识库里没有「' + name + '」')
          return
        }
        var internal = target.closest('[data-kb-path]')
        if (internal !== null) {
          event.preventDefault()
          var raw = unescapeAttr(internal.getAttribute('data-kb-path') || '')
          var next = joinPath(wikiDir(), raw)
          if (wikiIndexRef.current[next] !== undefined || (tree !== null && tree.files.some(function (file) {
            return file.path === next
          }))) openFile(next)
          else showToast('找不到目标文件：' + next)
          return
        }
        var anchor = target.closest('a[href^="#kb-h-"]')
        if (anchor !== null) {
          event.preventDefault()
          var id = anchor.getAttribute('href').slice(1)
          var node = docRef.current === null ? null : docRef.current.querySelector('#' + CSS.escape(id))
          if (node !== null) node.scrollIntoView({ behavior: 'smooth', block: 'start' })
        }
      }

      function wikiDir() {
        if (doc === null) return ''
        var parts = doc.path.split('/')
        parts.pop()
        return parts.join('/')
      }

      // ---- 树结构 ---------------------------------------------------------

      var filteredFiles = useMemo(function () {
        if (tree === null) return []
        return tree.files.filter(function (file) {
          if (typeFilter === 'issues') return file.issues.length > 0
          if (typeFilter !== '' && file.type !== typeFilter) return false
          if (tagFilter !== '' && file.tags.indexOf(tagFilter) < 0) return false
          return true
        })
      }, [tree, typeFilter, tagFilter])

      // 真目录树：每个节点带自己的子目录和本层文件
      var dirTree = useMemo(function () {
        var root = { name: '', path: '', children: new Map(), files: [] }
        for (var i = 0; i < filteredFiles.length; i += 1) {
          var file = filteredFiles[i]
          var parts = file.dir === '' ? [] : file.dir.split('/')
          var node = root
          for (var p = 0; p < parts.length; p += 1) {
            var part = parts[p]
            var path = node.path === '' ? part : node.path + '/' + part
            if (!node.children.has(part)) {
              node.children.set(part, { name: part, path: path, children: new Map(), files: [] })
            }
            node = node.children.get(part)
          }
          node.files.push(file)
        }
        return root
      }, [filteredFiles])

      function countInNode(node) {
        var total = node.files.length
        node.children.forEach(function (child) {
          total += countInNode(child)
        })
        return total
      }

      var starredFiles = useMemo(function () {
        if (tree === null) return []
        return tree.files.filter(function (file) {
          return stars.indexOf(file.path) >= 0
        })
      }, [tree, stars])

      var outline = useMemo(function () {
        if (doc === null) return []
        return collectOutline(doc.body)
      }, [doc])

      var renderedHtml = useMemo(function () {
        if (doc === null) return ''
        return renderMarkdown(doc.body, doc.dir)
      }, [doc])

      // ---- 渲染 -----------------------------------------------------------

      function badgeTone(type) {
        return TYPE_TONE[type] || 'muted'
      }

      function fileRow(file, depth) {
        var indent = typeof depth === 'number' && depth > 0 ? { paddingLeft: 8 + depth * 12 + 'px' } : null
        var isCurrent = file.path === selectedPath
        var starred = stars.indexOf(file.path) >= 0
        return h(
          'div',
          {
            key: 'file:' + file.path,
            className: 'dshkb-file' + (isCurrent ? ' dshkb-file--on' : ''),
            style: indent || undefined,
            role: 'button',
            tabIndex: 0,
            title: file.path + '\n' + (file.excerpt || ''),
            onClick: function () {
              openFile(file.path)
            },
            onKeyDown: function (event) {
              if (event.key === 'Enter' || event.key === ' ') openFile(file.path)
            },
          },
          h(
            'div',
            { className: 'dshkb-file-title' },
            h('span', null, file.title || file.stem),
            file.issues.length > 0
              ? h('span', { className: 'dshkb-dot', title: file.issues.join('、'), style: { background: '#d99a2b' } })
              : null,
            starred ? h('span', { title: '已收藏', style: { color: '#d9a300', fontSize: '11px' } }, '★') : null
          ),
          h(
            'div',
            { className: 'dshkb-file-sub' },
            file.type !== '' ? TYPE_LABEL[file.type] || file.type : '未标注 type',
            ' · ',
            relativeLabel(file.mtime)
          )
        )
      }

      function renderDirLevel(node, depth) {
        var out = []
        node.children.forEach(function (child) {
          var isOpen = expanded[child.path] === true
          out.push(
            h(
              'div',
              { key: 'dir:' + child.path },
              h(
                'div',
                {
                  className: 'dshkb-dir',
                  style: depth > 0 ? { paddingLeft: 8 + depth * 12 + 'px' } : null,
                  title: child.path,
                  onClick: function () {
                    setExpanded(function (previous) {
                      var next = Object.assign({}, previous)
                      next[child.path] = !isOpen
                      return next
                    })
                  },
                },
                h('span', { className: 'dshkb-caret' + (isOpen ? ' dshkb-caret--open' : '') }, '▸'),
                h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, child.name),
                h('span', { className: 'dshkb-count' }, String(countInNode(child)))
              ),
              isOpen
                ? h('div', { style: { paddingLeft: '10px' } }, renderDirLevel(child, depth + 1))
                : null
            )
          )
        })
        node.files.forEach(function (file) {
          out.push(fileRow(file, depth))
        })
        return out
      }

      function renderSidebar() {
        var head = h(
          'div',
          { className: 'dshkb-side-head' },
          h(
            'div',
            { className: 'dshkb-search' },
            h('span', { style: { color: 'var(--dsw-alias-label-tertiary,#9aa0aa)' } }, '⌕'),
            h('input', {
              value: query,
              placeholder: '搜索知识库…（标题 / 正文 / 路径）',
              onChange: function (event) {
                setQuery(event.target.value)
                if (event.target.value.trim() !== '' && mode !== 'search') setMode('search')
                if (event.target.value.trim() === '' && mode === 'search') setMode('tree')
              },
              onFocus: function () {
                if (query.trim() !== '') setMode('search')
              },
            }),
            query === ''
              ? null
              : h(
                'button',
                {
                  className: 'dshkb-tab',
                  title: '清空',
                  style: { padding: '0 4px', fontSize: '13px' },
                  onClick: function () {
                    setQuery('')
                    setMode('tree')
                    setResults(null)
                  },
                },
                '×'
              )
          ),
          h(
            'div',
            { className: 'dshkb-tabs' },
            [
              ['tree', '栏目'],
              ['recent', '最近'],
              ['star', '收藏' + (stars.length > 0 ? ' ' + stars.length : '')],
              ['issues', '待补' + (tree !== null && tree.issues > 0 ? ' ' + tree.issues : '')],
            ].map(function (item) {
              var key = item[0]
              var on = key === 'issues' ? typeFilter === 'issues' : mode === key && typeFilter !== 'issues'
              return h(
                'button',
                {
                  key: 'tab:' + key,
                  className: 'dshkb-tab' + (on ? ' dshkb-tab--on' : ''),
                  onClick: function () {
                    if (key === 'issues') {
                      setTypeFilter(typeFilter === 'issues' ? '' : 'issues')
                      setMode('tree')
                      return
                    }
                    setTypeFilter('')
                    setMode(key)
                    if (key === 'recent') loadRecent()
                  },
                },
                item[1]
              )
            })
          ),
          tree !== null
            ? h(
              'div',
              { className: 'dshkb-chips' },
              tree.types
                .filter(function (item) {
                  return item.key !== '(未标注)' || item.count > 0
                })
                .map(function (item) {
                  var on = typeFilter === item.key
                  return h(
                    'button',
                    {
                      key: 'type:' + item.key,
                      className: 'dshkb-chip' + (on ? ' dshkb-chip--on' : ''),
                      onClick: function () {
                        setTypeFilter(on ? '' : item.key)
                        setMode('tree')
                      },
                    },
                    (TYPE_LABEL[item.key] || item.key) + ' ' + item.count
                  )
                }),
              tagFilter === ''
                ? null
                : h(
                  'button',
                  {
                    className: 'dshkb-chip dshkb-chip--on',
                    onClick: function () {
                      setTagFilter('')
                    },
                  },
                  '#' + tagFilter + ' ×'
                )
            )
            : null
        )

        var body = null
        if (treeError !== '') {
          body = h('div', { className: 'dshkb-err' }, '读取知识库失败：' + treeError)
        } else if (tree === null) {
          body = h('div', { className: 'dshkb-loading' }, '正在建立索引…')
        } else if (mode === 'search') {
          body = renderSearchResults()
        } else if (mode === 'recent') {
          body = renderRecent()
        } else if (mode === 'star') {
          body = starredFiles.length === 0
            ? h('div', { className: 'dshkb-loading' }, '还没有收藏。文档右上角点 ☆ 就能收进来。')
            : h('div', null, starredFiles.map(function (file) {
              return fileRow(file)
            }))
        } else if (typeFilter === 'issues') {
          body = filteredFiles.length === 0
            ? h('div', { className: 'dshkb-loading' }, '全部合规，没有要补的 frontmatter。')
            : h(
              'div',
              null,
              h('div', { className: 'dshkb-loading' }, '缺 type / updated / status 的文档（写错会被 kb-guard 提示）：'),
              filteredFiles.map(function (file) {
                return fileRow(file)
              })
            )
        } else {
          body = h('div', null, renderDirLevel(dirTree, 0))
        }

        return h(
          'div',
          { className: 'dshkb-side' },
          head,
          h('div', { className: 'dshkb-scroll' }, body),
          h(
            'div',
            { className: 'dshkb-foot' },
            h(
              'span',
              { className: 'dshkb-live' + (connected ? ' dshkb-live--on' : '') },
              h('i', null),
              connected ? '实时同步' : '重连中…'
            ),
            h('span', null, tree === null ? '' : tree.count + ' 篇'),
            h(
              'button',
              {
                className: 'dshkb-tab',
                style: { marginLeft: 'auto', padding: '0 6px' },
                title: '重新扫描',
                onClick: manualRescan,
              },
              '↻'
            )
          )
        )
      }

      function highlight(text) {
        var terms = query.trim().toLowerCase().split(/\s+/).filter(function (item) {
          return item !== ''
        })
        if (terms.length === 0) return text
        var source = escapeHtml(text)
        for (var i = 0; i < terms.length; i += 1) {
          var term = escapeHtml(terms[i]).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
          if (term === '') continue
          source = source.replace(new RegExp(term, 'gi'), function (match) {
            return '<em>' + match + '</em>'
          })
        }
        return source
      }

      function renderSearchResults() {
        if (searching && results === null) return h('div', { className: 'dshkb-loading' }, '搜索中…')
        if (results === null) return h('div', { className: 'dshkb-loading' }, '输入关键词，全文搜索知识库。')
        if (results.length === 0) return h('div', { className: 'dshkb-loading' }, '没有命中。')
        return h(
          'div',
          null,
          h('div', { className: 'dshkb-loading' }, '命中 ' + results.length + ' 篇'),
          results.map(function (item) {
            var isCurrent = item.path === selectedPath
            return h(
              'div',
              {
                key: 'hit:' + item.path,
                className: 'dshkb-result' + (isCurrent ? ' dshkb-result--on' : ''),
                role: 'button',
                onClick: function () {
                  openFile(item.path)
                },
              },
              h(
                'div',
                { className: 'dshkb-result-title' },
                h('span', {
                  dangerouslySetInnerHTML: { __html: highlight(item.title) },
                }),
                item.type === ''
                  ? null
                  : h('span', { className: 'dshkb-badge dshkb-badge--' + badgeTone(item.type) }, TYPE_LABEL[item.type] || item.type)
              ),
              h('div', { className: 'dshkb-result-path' }, item.path),
              item.matches.map(function (match, index) {
                return h('div', {
                  key: 'line:' + index,
                  className: 'dshkb-result-line',
                  dangerouslySetInnerHTML: { __html: 'L' + match.line + '  ' + highlight(match.text) },
                })
              })
            )
          })
        )
      }

      function renderRecent() {
        if (recent === null) return h('div', { className: 'dshkb-loading' }, '读取最近更新…')
        if (recent.length === 0) return h('div', { className: 'dshkb-loading' }, '还没有文档。')
        return h(
          'div',
          null,
          h('div', { className: 'dshkb-loading' }, '按磁盘修改时间排序，最近 80 篇'),
          recent.map(function (file) {
            var isCurrent = file.path === selectedPath
            return h(
              'div',
              {
                key: 'recent:' + file.path,
                className: 'dshkb-result' + (isCurrent ? ' dshkb-result--on' : ''),
                role: 'button',
                onClick: function () {
                  openFile(file.path)
                },
              },
              h('div', { className: 'dshkb-result-title' }, h('span', null, file.title || file.stem)),
              h('div', { className: 'dshkb-result-path' }, relativeLabel(file.mtime) + ' · ' + file.path)
            )
          })
        )
      }

      function renderDoc() {
        if (docLoading && doc === null) {
          return h('div', { className: 'dshkb-empty' }, '加载中…')
        }
        if (docError !== '') {
          return h('div', { className: 'dshkb-empty' }, h('strong', null, '打不开这篇'), h('span', null, docError))
        }
        if (doc === null) {
          return h(
            'div',
            { className: 'dshkb-empty' },
            h(BookIcon, { size: 34 }),
            h('strong', null, '知识库面板'),
            h('span', null, tree === null ? '正在读取…' : '左边点一篇文档开始看；选中文字可以直接问小鲸鱼。'),
            h(
              'span',
              null,
              '共 ' + (tree === null ? '—' : tree.count) + ' 篇 · 每秒扫描磁盘',
              tree !== null ? ' · ' + tree.root : ''
            ),
            h('span', null, '存盘即同步 · 不用手动刷新')
          )
        }

        var badges = []
        badges.push(h('span', { key: 'badge-type', className: 'dshkb-badge dshkb-badge--' + badgeTone(doc.frontmatter.type) },
          'type: ' + (TYPE_LABEL[doc.frontmatter.type] || doc.frontmatter.type || '未标注')))
        if (doc.frontmatter.status) {
          badges.push(h('span', { key: 'badge-status', className: 'dshkb-badge dshkb-badge--ok' }, 'status: ' + doc.frontmatter.status))
        }
        if (doc.frontmatter.updated) {
          badges.push(h('span', { key: 'badge-updated', className: 'dshkb-badge' }, 'updated: ' + doc.frontmatter.updated))
        }
        var tags = doc.frontmatter.tags
        if (Array.isArray(tags)) {
          for (var i = 0; i < tags.length; i += 1) {
            badges.push(h('span', {
              key: 'tag:' + i,
              className: 'dshkb-badge',
              style: { cursor: 'pointer' },
              title: '按这个标签过滤',
              onClick: function (tagValue) {
                return function () {
                  setTagFilter(tagValue)
                  setTypeFilter('')
                  setMode('tree')
                }
              }(tags[i]),
            }, '#' + tags[i]))
          }
        }
        var extraKeys = Object.keys(doc.frontmatter).filter(function (key) {
          return ['type', 'status', 'updated', 'tags', 'name', 'title'].indexOf(key) < 0
        })
        for (var k = 0; k < extraKeys.length && k < 8; k += 1) {
          var key = extraKeys[k]
          var value = doc.frontmatter[key]
          var text = Array.isArray(value) ? value.join(', ') : String(value)
          if (text === '' || text === '[object Object]') continue
          badges.push(h('span', { key: 'meta:' + key, className: 'dshkb-badge' }, key + ': ' + text.slice(0, 40)))
        }

        return h(
          'div',
          { className: 'dshkb-main', key: 'doc-main' },
          h(
            'div',
            { className: 'dshkb-top' },
            h('h2', { title: doc.path }, doc.title),
            h(
              'div',
              { className: 'dshkb-top-actions' },
              h(
                'button',
                {
                  className: 'dshkb-btn',
                  title: stars.indexOf(doc.path) >= 0 ? '取消收藏' : '收藏这篇',
                  onClick: function () {
                    toggleStar(doc.path)
                  },
                },
                stars.indexOf(doc.path) >= 0 ? '★' : '☆'
              ),
              h('button', { className: 'dshkb-btn', title: '复制绝对路径', onClick: copyPath }, '路径'),
              h('button', { className: 'dshkb-btn', title: '复制 [[wiki]] 链接', onClick: copyWiki }, '链接'),
              h('button', { className: 'dshkb-btn', title: '把这篇文档的引用塞进当前会话的输入栏', onClick: quoteToComposer }, '引用'),
              h('button', { className: 'dshkb-btn', title: '在系统文件管理器打开所在目录', onClick: revealInManager }, '本机'),
              h('button', { className: 'dshkb-btn dshkb-btn--primary', title: '把这篇的解读请求放进当前会话的输入栏', onClick: askWholeDoc }, '解读')
            )
          ),
          h(
            'div',
            { className: 'dshkb-body', ref: docRef, onMouseUp: handleMouseUp },
            h(
              'div',
              { className: 'dshkb-doc' },
              h('div', { className: 'dshkb-badges' }, badges),
              doc.issues.length > 0
                ? h('div', { className: 'dshkb-warnbox' }, '⚠ frontmatter 不合 KB 规则：' + doc.issues.join('、') + '（照 KB/Rule.md 补上）')
                : null,
              h('div', { className: 'dshkb-meta' },
                h('span', null, doc.path),
                h('span', null, bytesLabel(doc.size)),
                h('span', null, '约 ' + doc.words + ' 字'),
                h('span', null, '改于 ' + timeLabel(doc.mtime))
              ),
              outline.length > 1
                ? h(
                  'details',
                  { className: 'dshkb-outline' },
                  h('summary', null, '大纲（' + outline.length + ' 节）'),
                  h('ol', null, outline.map(function (item, index) {
                    return h(
                      'li',
                      { key: 'toc:' + index, className: 'lv' + item.level },
                      h('a', { onClick: function () {
                        var node = docRef.current === null ? null : docRef.current.querySelector('#' + CSS.escape(item.id))
                        if (node !== null) node.scrollIntoView({ behavior: 'smooth', block: 'start' })
                      } }, item.text)
                    )
                  }))
                )
                : null,
              h('div', {
                className: 'dshkb-markdown',
                onClick: handleDocClick,
                dangerouslySetInnerHTML: { __html: renderedHtml },
              }),
              doc.links.length > 0 || doc.backlinks.length > 0
                ? h(
                  'div',
                  { className: 'dshkb-links' },
                  doc.links.length > 0
                    ? h(
                      'div',
                      null,
                      h('h4', null, '出链（' + doc.links.length + '）'),
                      h('ul', null, doc.links.map(function (link, index) {
                        return h(
                          'li',
                          { key: 'out:' + index },
                          h('a', {
                            style: link.resolved ? undefined : { color: 'var(--dsw-alias-label-tertiary,#9aa0aa)' },
                            onClick: function () {
                              if (link.resolved) openFile(link.target)
                              else showToast('未解析：' + link.target)
                            },
                          }, (link.kind === 'wiki' ? '⧉ ' : '↗ ') + (link.label || link.target))
                        )
                      }))
                    )
                    : null,
                  doc.backlinks.length > 0
                    ? h(
                      'div',
                      null,
                      h('h4', null, '反向链接（' + doc.backlinks.length + '）'),
                      h('ul', null, doc.backlinks.map(function (item, index) {
                        return h(
                          'li',
                          { key: 'back:' + index },
                          h('a', { onClick: function () {
                            openFile(item.path)
                          } }, item.title || item.path)
                        )
                      }))
                    )
                    : null
                )
                : null
            )
          ),
          h(
            'div',
            { className: 'dshkb-ask' },
            h('input', {
              value: askText,
              placeholder: '针对这篇问一句，回车就放进当前会话的输入栏…',
              onChange: function (event) {
                setAskText(event.target.value)
              },
              onKeyDown: function (event) {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault()
                  askAboutDoc()
                }
              },
            }),
            h('button', { className: 'dshkb-btn dshkb-btn--primary', disabled: askText.trim() === '', onClick: askAboutDoc }, '问小鲸鱼'),
            h('button', { className: 'dshkb-btn', title: '带着这个问题另开一个新会话', onClick: askAboutDocNewSession }, '新会话提问')
          )
        )
      }
      // Esc 关掉工作区选择框
      useEffect(function () {
        if (wsPrompt === null) return undefined
        function onKeyDown(event) {
          if (event.key === 'Escape') setWsPrompt(null)
        }
        document.addEventListener('keydown', onKeyDown)
        return function () {
          document.removeEventListener('keydown', onKeyDown)
        }
      }, [wsPrompt])

      // 「新会话提问」先问一句：建在哪个工作区？
      function renderWsPicker() {
        if (wsPrompt === null) return null
        var items = listWorkspaces()
        var currentId = currentWorkspaceId()
        var ordered = items.slice().sort(function (a, b) {
          if (a.workspaceId === currentId) return -1
          if (b.workspaceId === currentId) return 1
          return 0
        })
        return h(
          'div',
          {
            className: 'dshkb-modal',
            onMouseDown: function (event) {
              if (event.target === event.currentTarget) setWsPrompt(null)
            },
          },
          h(
            'div',
            { className: 'dshkb-modal-card' },
            h('div', { className: 'dshkb-modal-head' }, '新会话建在哪个工作区？'),
            h('div', { className: 'dshkb-modal-sub' }, '问题只放进新会话的输入栏，不会自动发送。'),
            h(
              'div',
              { className: 'dshkb-modal-list' },
              ordered.length === 0
                ? h('div', { className: 'dshkb-modal-empty' }, '没读到工作区列表，可以直接按当前工作区新建。')
                : ordered.map(function (item) {
                    return h(
                      'button',
                      {
                        key: item.workspaceId,
                        className: 'dshkb-ws' + (item.workspaceId === currentId ? ' dshkb-ws--current' : ''),
                        onClick: function () {
                          confirmNewSession(item.workspaceId)
                        },
                      },
                      h('span', { className: 'dshkb-ws-title' }, item.title || item.path),
                      h(
                        'span',
                        { className: 'dshkb-ws-meta' },
                        (item.workspaceId === currentId ? '当前 · ' : '') +
                          (Array.isArray(item.sessionIds) ? item.sessionIds.length : 0) +
                          ' 个会话 · ' +
                          item.path
                      )
                    )
                  })
            ),
            h(
              'div',
              { className: 'dshkb-modal-foot' },
              h('button', { className: 'dshkb-btn', onClick: function () { setWsPrompt(null) } }, '取消'),
              h('button', { className: 'dshkb-btn dshkb-btn--primary', onClick: function () { confirmNewSession(undefined) } }, '跟随当前工作区')
            )
          )
        )
      }

      function toggleSide() {
        setSideCollapsed(function (previous) {
          var next = previous !== true
          writeSideCollapsed(next)
          return next
        })
      }

      function renderTopbar() {
        return h(
          'div',
          { className: 'dshkb-topbar' },
          h(
            'button',
            {
              className: 'dshkb-toggle dshkb-toggle--side',
              title: sideCollapsed ? '展开目录' : '收起目录',
              onClick: toggleSide,
            },
            sideCollapsed ? '☰ 目录' : '◀ 收起'
          ),
          h(
            'span',
            {
              className: 'dshkb-topbar-title',
              title: doc === null ? '知识库' : doc.path || '',
            },
            doc === null ? '知识库' : doc.dir ? doc.dir : '根目录'
          ),
          h('span', { className: 'dshkb-spacer' }),
          h(
            'span',
            {
              className: 'dshkb-live' + (connected ? ' dshkb-live--on' : ''),
              style: { fontSize: '11px', color: 'var(--dsw-alias-label-tertiary,#9aa0aa)' },
            },
            h('i', null),
            connected ? '实时' : '重连中'
          )
        )
      }

      return h(
        'div',
        { className: 'dshkb' + (sideCollapsed ? ' dshkb--collapsed' : ''), onMouseDown: function (event) {
          if (selection !== null && !(event.target instanceof Element && event.target.closest('.dshkb-selectbar'))) {
            setSelection(null)
          }
        } },
        renderTopbar(),
        h('div', { className: 'dshkb-inner' }, renderSidebar(), renderDoc()),
        renderWsPicker(),
        selection === null
          ? null
          : h(
            'div',
            {
              className: 'dshkb-selectbar',
              style: { left: selection.x + 'px', top: selection.y + 'px', transform: 'translateX(-50%)' },
              onMouseUp: function (event) {
                event.stopPropagation()
              },
            },
            h('button', { onClick: function () { askSelection('explain') } }, '解读这段'),
            h('button', { onClick: function () { askSelection('follow') } }, '继续分析'),
            h('button', { onClick: function () { askSelection('summarize') } }, '总结'),
            h('button', {
              onClick: function () {
                copyText(selection.text).then(function () {
                  showToast('已复制选中内容')
                })
                setSelection(null)
              },
            }, '复制')
          ),
        toast === null ? null : h('div', { className: 'dshkb-toast' }, toast.text),
        lastSync === null
          ? null
          : h('div', {
            style: {
              position: 'fixed',
              right: '18px',
              bottom: '62px',
              zIndex: 55,
              fontSize: '11px',
              color: 'var(--dsw-alias-label-tertiary,#9aa0aa)',
            },
          }, '上次同步：' + relativeLabel(lastSync.at) + '（+' + lastSync.added + ' ~' + lastSync.changed + ' -' + lastSync.removed + '）')
      )

    }

    // ---- 注册 -------------------------------------------------------------

    function apply(ctx) {
      ensureStyles()

      ctx.inject(['layout'], function (scope) {
        services.layout = scope.layout
      })
      ctx.inject(['uiWorkspace'], function (scope) {
        services.uiWorkspace = scope.uiWorkspace
      })

      ctx.inject(['sidebarRight'], function (scope) {
        services.sidebarRight = scope.sidebarRight
      })

      ctx.inject(['workspaces'], function (scope) {
        services.workspaces = scope.workspaces
      })

      // 右栏页类型（第一阶段）：kind 只是类型判别符，正文用 PANEL_ID 注册。
      ctx.inject(['sidebarRightTabs'], function (scope) {
        scope.effect(function () {
          return scope.sidebarRightTabs.register({
            id: PANEL_ID,
            kind: KB_KIND,
            priority: 'extension',
            title: function () {
              return '知识库'
            },
            guide: [
              {
                id: 'md-panel',
                order: 40,
                title: function () {
                  return '知识库'
                },
                description: function () {
                  return '浏览 / 搜索本地 KB，选中一段直接问小鲸鱼'
                },
                icon: BookIcon,
              },
            ],
          })
        })
      })

      // 右栏页正文（第二阶段）：props 带 sessionId 与 hooks.tabInfo。
      ctx.slots.inject('sidebar.right.pane.tab', function () {
        return ctx.slots.register(
          {
            name: 'sidebar.right.pane.tab',
            key: PANEL_ID,
            registrant: PANEL_ID,
          },
          function (props) {
            return h(KbPanel, props)
          }
        )
      })

      ctx.slots.inject('sidebar.right.pane.tab.title', function () {
        return ctx.slots.register(
          {
            name: 'sidebar.right.pane.tab.title',
            key: PANEL_ID,
            registrant: PANEL_ID,
          },
          function () {
            return h('span', null, '知识库')
          }
        )
      })

      // 会话输入栏左侧挂一个隐形占位，借它拿到当前会话的 inputActions。
      ctx.slots.inject('conversation.input.left', function () {
        return ctx.slots.register(
          {
            name: 'conversation.input.left',
            id: PANEL_ID + ':bridge',
            order: 90,
            registrant: PANEL_ID,
            inject: function (sessionId) {
              return { sessionId: sessionId }
            },
          },
          KbComposerBridge
        )
      })

      // 入口：会话标题右侧一个「知识库」按钮，点开右栏面板。
      ctx.slots.inject('conversation.session.header.utilities', function () {
        return ctx.slots.register(
          {
            name: 'conversation.session.header.utilities',
            id: PANEL_ID + ':header',
            order: 12,
            registrant: PANEL_ID,
          },
          function () {
            return h(
              'button',
              {
                className: 'dshkb-toggle',
                title: '打开知识库右栏面板',
                onClick: function () {
                  openKbTab()
                },
              },
              h(BookIcon, { size: 13 })
            )
          }
        )
      })
    }

    module.exports = {
      name: PANEL_ID,
      inject: ['slots'],
      apply: apply,
    }
    return module.exports
  },
})
