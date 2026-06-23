    async function loadGraph() {
      var el = document.getElementById('view-graph');
      el.innerHTML = '<div class="loading">检查关系图数据中...</div>';

      var results = await Promise.all([
        apiPost('graph/query', {}),
        apiGet('graph/stats')
      ]);
      var queryResult = results[0] || { nodes: [], edges: [] };
      state.graph.nodes = queryResult.nodes || [];
      state.graph.edges = queryResult.edges || [];
      state.graph.stats = results[1] || {};

      if (state.graph.nodes.length === 0) {
        state.graph.loaded = true;
        el.innerHTML =
          '<div class="empty-state" style="max-width:720px;margin:40px auto;">' +
          '<div class="empty-icon">&#128376;</div>' +
          '<div class="empty-title">关系图暂时隐藏</div>' +
          '<div class="empty-lead">当前没有可展示的节点和连线，所以侧边栏不再显示这个入口。等系统真的提取出关系后，再把关系图作为可用功能放回来。</div>' +
          '<pre class="empty-cmd">需要关系图时：配置 LLM key，并开启 GRAPH_EXTRACTION_ENABLED=true 后重启。</pre>' +
          '</div>';
        return;
      }

      el.innerHTML = '<div class="graph-container"><div class="graph-canvas-wrap"><canvas id="graph-canvas"></canvas><div class="graph-controls"><button title="放大" data-action="zoom-graph" data-dir="1">+</button><button title="缩小" data-action="zoom-graph" data-dir="-1">&minus;</button><div class="ctrl-divider"></div><button title="回到中心" data-action="recenter-graph">⌖</button></div><div class="graph-tooltip" id="graph-tooltip"></div></div><div class="graph-sidebar" id="graph-sidebar"></div></div>';
      state.graph.loaded = true;
      var types = {};
      state.graph.nodes.forEach(function(n) { types[n.type] = true; });
      state.graph.filters = types;

      renderGraphSidebar();
      initGraph();
    }

    var NODE_SHAPES = {
      file: 'rect', function: 'circle', concept: 'circle', error: 'diamond',
      decision: 'diamond', pattern: 'circle', library: 'hexagon', person: 'circle'
    };
    var graphSearchTerm = '';

    function renderGraphSidebar() {
      var sb = document.getElementById('graph-sidebar');
      if (!sb) return;
      var gs = state.graph.stats || {};
      var nodeCount = gs.totalNodes !== undefined ? gs.totalNodes : (gs.nodes !== undefined ? gs.nodes : (gs.nodeCount || state.graph.nodes.length));
      var edgeCount = gs.totalEdges !== undefined ? gs.totalEdges : (gs.edges !== undefined ? gs.edges : (gs.edgeCount || state.graph.edges.length));

      var html = '<input type="text" class="graph-search" id="graph-search" placeholder="搜索节点...">';

      html += '<h3 style="margin-top:16px;font-size:10px;text-transform:uppercase;letter-spacing:0.12em;color:var(--ink-muted);font-family:var(--font-ui);font-weight:700;">图谱统计</h3>';
      html += '<div style="display:flex;gap:20px;margin:10px 0 16px;padding:12px;background:var(--bg-alt);border:1px solid var(--border-light);border-radius:4px;">';
      html += '<div style="text-align:center;flex:1;"><span style="font-size:28px;font-weight:900;font-family:var(--font-display);color:var(--ink);line-height:1;">' + nodeCount + '</span><div style="font-size:8px;color:var(--ink-faint);text-transform:uppercase;letter-spacing:0.12em;font-family:var(--font-ui);font-weight:600;margin-top:4px;">Nodes</div></div>';
      html += '<div style="width:1px;background:var(--border-light);"></div>';
      html += '<div style="text-align:center;flex:1;"><span style="font-size:28px;font-weight:900;font-family:var(--font-display);color:var(--ink);line-height:1;">' + edgeCount + '</span><div style="font-size:8px;color:var(--ink-faint);text-transform:uppercase;letter-spacing:0.12em;font-family:var(--font-ui);font-weight:600;margin-top:4px;">Edges</div></div>';
      html += '</div>';

      html += '<h3 style="margin-top:12px;font-size:10px;text-transform:uppercase;letter-spacing:0.12em;color:var(--ink-muted);font-family:var(--font-ui);font-weight:700;">按类型筛选</h3>';
      Object.keys(state.graph.filters).forEach(function(type) {
        var color = NODE_COLORS[type] || '#666666';
        html += '<label class="filter-item"><input type="checkbox" checked data-type="' + esc(type) + '"><span class="filter-dot" style="background:' + color + '"></span>' + esc(type) + '</label>';
      });

      html += '<div class="graph-legend"><h3>图例</h3>';
      var shapeLabels = { rect: '&#9645;', circle: '&#9679;', diamond: '&#9670;', hexagon: '&#11042;' };
      var shownShapes = {};
      Object.keys(NODE_COLORS).forEach(function(type) {
        var shape = NODE_SHAPES[type] || 'circle';
        var color = NODE_COLORS[type];
        var key = type;
        if (shownShapes[key]) return;
        shownShapes[key] = true;
        html += '<div class="graph-legend-item"><span class="graph-legend-shape" style="color:' + color + ';font-size:14px;">' + (shapeLabels[shape] || '&#9679;') + '</span><span>' + esc(type) + '</span></div>';
      });
      html += '</div>';

      html += '<button class="btn" style="margin-top:14px;width:100%;font-size:11px;padding:8px;letter-spacing:0.06em;transition:all 0.15s ease;" data-action="rebuild-graph">↻ 重建关系图</button>';
      html += '<div id="selected-node-panel"></div>';
      var __focus = captureSearchFocus(['graph-search']);
      sb.innerHTML = html;

      sb.querySelectorAll('input[type="checkbox"]').forEach(function(cb) {
        cb.addEventListener('change', function() {
          state.graph.filters[this.dataset.type] = this.checked;
          renderGraph();
        });
      });

      var searchInput = document.getElementById('graph-search');
      if (searchInput) {
        bindImeSafeSearch(searchInput, 200, function(v){ graphSearchTerm = v.toLowerCase(); renderGraph(); });
      }
      restoreSearchFocus(__focus);
    }

    function initGraph() {
      var canvas = document.getElementById('graph-canvas');
      if (!canvas) return;
      graphSim.canvas = canvas;
      graphSim.ctx = canvas.getContext('2d');

      function resize() {
        var r = canvas.parentElement.getBoundingClientRect();
        canvas.width = r.width * window.devicePixelRatio;
        canvas.height = r.height * window.devicePixelRatio;
        canvas.style.width = r.width + 'px';
        canvas.style.height = r.height + 'px';
        graphSim.ctx.setTransform(window.devicePixelRatio, 0, 0, window.devicePixelRatio, 0, 0);
      }
      resize();
      window.addEventListener('resize', resize);

      var cw = canvas.width / window.devicePixelRatio;
      var ch = canvas.height / window.devicePixelRatio;
      graphSim.panX = cw / 2;
      graphSim.panY = ch / 2;

      var edgeMap = {};
      state.graph.edges.forEach(function(e) {
        edgeMap[e.sourceNodeId] = (edgeMap[e.sourceNodeId] || 0) + 1;
        edgeMap[e.targetNodeId] = (edgeMap[e.targetNodeId] || 0) + 1;
      });

      graphSim.nodes = state.graph.nodes.map(function(n, i) {
        var angle = (2 * Math.PI * i) / Math.max(state.graph.nodes.length, 1);
        var radius = Math.min(cw, ch) * 0.3;
        var deg = edgeMap[n.id] || 0;
        return {
          id: n.id, type: n.type, name: n.name, properties: n.properties,
          x: Math.cos(angle) * radius + (Math.random() - 0.5) * 50,
          y: Math.sin(angle) * radius + (Math.random() - 0.5) * 50,
          vx: 0, vy: 0,
          r: Math.max(8, Math.min(22, 8 + deg * 2.5))
        };
      });
      graphSim.edges = state.graph.edges.slice();
      graphSim.running = true;
      graphSim.dragNode = null;

      setupGraphInteraction(canvas);
      runSimulation();
    }

    function setupGraphInteraction(canvas) {
      var isPanning = false;
      var lastMX = 0, lastMY = 0;

      function canvasCoords(e) {
        var rect = canvas.getBoundingClientRect();
        return {
          x: (e.clientX - rect.left - graphSim.panX) / graphSim.zoom,
          y: (e.clientY - rect.top - graphSim.panY) / graphSim.zoom
        };
      }
      function findNode(cx, cy) {
        for (var i = graphSim.nodes.length - 1; i >= 0; i--) {
          var n = graphSim.nodes[i];
          if (!state.graph.filters[n.type]) continue;
          var dx = n.x - cx, dy = n.y - cy;
          if (dx * dx + dy * dy < n.r * n.r + 25) return n;
        }
        return null;
      }

      canvas.addEventListener('mousedown', function(e) {
        var c = canvasCoords(e);
        var node = findNode(c.x, c.y);
        if (node) {
          graphSim.dragNode = node;
        } else {
          isPanning = true;
        }
        lastMX = e.clientX;
        lastMY = e.clientY;
        // wake the simulation if it parked itself after settling
        wakeGraphSim();
      });
      canvas.addEventListener('mousemove', function(e) {
        var dx = e.clientX - lastMX;
        var dy = e.clientY - lastMY;
        if (graphSim.dragNode) {
          graphSim.dragNode.x += dx / graphSim.zoom;
          graphSim.dragNode.y += dy / graphSim.zoom;
          graphSim.dragNode.vx = 0;
          graphSim.dragNode.vy = 0;
        } else if (isPanning) {
          graphSim.panX += dx;
          graphSim.panY += dy;
        }
        lastMX = e.clientX;
        lastMY = e.clientY;
        graphSim.mouseX = e.clientX;
        graphSim.mouseY = e.clientY;

        var c = canvasCoords(e);
        var hoverNode = findNode(c.x, c.y);
        var tooltip = document.getElementById('graph-tooltip');
        if (tooltip) {
          if (hoverNode && !graphSim.dragNode && !isPanning) {
            var conns = graphSim.edges.filter(function(ed) { return ed.sourceNodeId === hoverNode.id || ed.targetNodeId === hoverNode.id; }).length;
            var ttHtml = '<div class="tt-name">' + esc(hoverNode.name) + '</div>';
            ttHtml += '<div class="tt-type" style="color:' + (NODE_COLORS[hoverNode.type] || '#666') + '">' + esc(hoverNode.type) + '</div>';
            if (hoverNode.properties) {
              var propKeys = Object.keys(hoverNode.properties).slice(0, 3);
              propKeys.forEach(function(k) {
                ttHtml += '<div class="tt-prop">' + esc(k) + ': ' + esc(truncate(String(hoverNode.properties[k]), 30)) + '</div>';
              });
            }
            ttHtml += '<div class="tt-conns">' + conns + ' connection' + (conns !== 1 ? 's' : '') + '</div>';
            tooltip.innerHTML = ttHtml;
            var rect = canvas.getBoundingClientRect();
            tooltip.style.left = (e.clientX - rect.left + 12) + 'px';
            tooltip.style.top = (e.clientY - rect.top + 12) + 'px';
            tooltip.classList.add('visible');
            canvas.style.cursor = 'pointer';
          } else {
            tooltip.classList.remove('visible');
            canvas.style.cursor = graphSim.dragNode || isPanning ? 'grabbing' : 'grab';
          }
        }
      });
      canvas.addEventListener('mouseup', function(e) {
        if (graphSim.dragNode && !isPanning) {
          selectGraphNode(graphSim.dragNode);
        }
        graphSim.dragNode = null;
        isPanning = false;
      });
      canvas.addEventListener('wheel', function(e) {
        e.preventDefault();
        var factor = e.deltaY > 0 ? 0.9 : 1.1;
        graphSim.zoom = Math.max(0.1, Math.min(5, graphSim.zoom * factor));
        // zoom is visually meaningless if the rAF loop is parked —
        // wake the simulation so the next frame redraws at the new scale.
        wakeGraphSim();
      }, { passive: false });
      canvas.addEventListener('dblclick', function(e) {
        var c = canvasCoords(e);
        var node = findNode(c.x, c.y);
        if (node) {
          selectGraphNode(node);
          expandNode(node.id);
        }
      });
    }

    window.zoomGraph = function(dir) {
      var factor = dir > 0 ? 1.25 : 0.8;
      graphSim.zoom = Math.max(0.1, Math.min(5, graphSim.zoom * factor));
      wakeGraphSim();
    };
    window.recenterGraph = function() {
      graphSim.zoom = 1;
      if (graphSim.canvas) {
        var cw = graphSim.canvas.width / window.devicePixelRatio;
        var ch = graphSim.canvas.height / window.devicePixelRatio;
        graphSim.panX = cw / 2;
        graphSim.panY = ch / 2;
      }
      wakeGraphSim();
    };

    function selectGraphNode(simNode) {
      state.graph.selectedNode = simNode;
      var panel = document.getElementById('selected-node-panel');
      if (!panel) return;
      var color = NODE_COLORS[simNode.type] || '#666666';
      var html = '<div class="selected-node-info">';
      html += '<h4 style="color:' + color + '">' + esc(simNode.name) + '</h4>';
      html += '<div class="prop">Type: ' + esc(simNode.type) + '</div>';
      if (simNode.properties) {
        Object.keys(simNode.properties).forEach(function(k) {
          html += '<div class="prop">' + esc(k) + ': ' + esc(truncate(simNode.properties[k], 50)) + '</div>';
        });
      }
      var conns = graphSim.edges.filter(function(e) { return e.sourceNodeId === simNode.id || e.targetNodeId === simNode.id; }).length;
      html += '<div class="prop">Connections: ' + conns + '</div>';
      html += '<button class="btn btn-primary" style="margin-top:8px;width:100%;" data-action="expand-node" data-node-id="' + esc(simNode.id) + '">展开相邻节点</button>';
      html += '</div>';
      panel.innerHTML = html;
    }

    async function expandNode(nodeId) {
      var result = await apiPost('graph/query', { startNodeId: nodeId, maxDepth: 1 });
      if (!result) return;
      var existingIds = {};
      graphSim.nodes.forEach(function(n) { existingIds[n.id] = true; });
      var parentNode = graphSim.nodes.find(function(n) { return n.id === nodeId; });
      var px = parentNode ? parentNode.x : 0;
      var py = parentNode ? parentNode.y : 0;

      (result.nodes || []).forEach(function(n) {
        if (!existingIds[n.id]) {
          state.graph.nodes.push(n);
          if (!state.graph.filters.hasOwnProperty(n.type)) state.graph.filters[n.type] = true;
          var angle = Math.random() * Math.PI * 2;
          graphSim.nodes.push({
            id: n.id, type: n.type, name: n.name, properties: n.properties,
            x: px + Math.cos(angle) * 80,
            y: py + Math.sin(angle) * 80,
            vx: 0, vy: 0, r: 8
          });
        }
      });

      var existingEdges = {};
      graphSim.edges.forEach(function(e) { existingEdges[e.id] = true; });
      (result.edges || []).forEach(function(e) {
        if (!existingEdges[e.id]) {
          state.graph.edges.push(e);
          graphSim.edges.push(e);
        }
      });
      renderGraphSidebar();
    }

    function runSimulation() {
      if (!graphSim.running) return;
      var nodes = graphSim.nodes;
      var edges = graphSim.edges;
      var nodeCount = nodes.length;
      graphSim.tickCount = (graphSim.tickCount || 0) + 1;
      // dense graphs (>1000 nodes) used to oscillate forever
      // because the per-node force pile-up exceeded what 0.9 damping
      // could bleed off each tick. Tick-decay tightens damping over
      // time so the layout actually settles; a per-node velocity cap
      // prevents any single node from being launched off-screen by an
      // accumulated kick before damping catches up.
      var coolBoost = Math.min(0.4, graphSim.tickCount / 1500);
      var damping = 0.9 - coolBoost;
      var repulsion = nodeCount > 1000 ? 3000 : nodeCount > 100 ? 2000 : nodeCount > 50 ? 1200 : 800;
      var attraction = nodeCount > 100 ? 0.002 : 0.005;
      var centerGravity = nodeCount > 1000 ? 0.012 : nodeCount > 100 ? 0.005 : 0.01;
      var velocityCap = nodeCount > 1000 ? 6 : nodeCount > 200 ? 12 : 24;

      var nodeMap = {};
      nodes.forEach(function(n) { nodeMap[n.id] = n; });

      for (var i = 0; i < nodes.length; i++) {
        if (graphSim.dragNode === nodes[i]) continue;
        var n = nodes[i];
        var fx = 0, fy = 0;
        for (var j = 0; j < nodes.length; j++) {
          if (i === j) continue;
          var dx = n.x - nodes[j].x;
          var dy = n.y - nodes[j].y;
          var dist = Math.sqrt(dx * dx + dy * dy) || 1;
          var force = repulsion / (dist * dist);
          fx += (dx / dist) * force;
          fy += (dy / dist) * force;
        }
        fx -= n.x * centerGravity;
        fy -= n.y * centerGravity;
        var nvx = (n.vx + fx) * damping;
        var nvy = (n.vy + fy) * damping;
        // Velocity cap (#563): keep any single node from being launched
        // off-screen by a one-tick force spike.
        if (nvx > velocityCap) nvx = velocityCap; else if (nvx < -velocityCap) nvx = -velocityCap;
        if (nvy > velocityCap) nvy = velocityCap; else if (nvy < -velocityCap) nvy = -velocityCap;
        n.vx = nvx;
        n.vy = nvy;
      }

      edges.forEach(function(e) {
        var s = nodeMap[e.sourceNodeId];
        var t = nodeMap[e.targetNodeId];
        if (!s || !t) return;
        var dx = t.x - s.x;
        var dy = t.y - s.y;
        var dist = Math.sqrt(dx * dx + dy * dy) || 1;
        var f = (dist - 100) * attraction;
        var fx = (dx / dist) * f;
        var fy = (dy / dist) * f;
        if (graphSim.dragNode !== s) { s.vx += fx; s.vy += fy; }
        if (graphSim.dragNode !== t) { t.vx -= fx; t.vy -= fy; }
      });

      var totalKineticEnergy = 0;
      nodes.forEach(function(n) {
        if (graphSim.dragNode === n) return;
        n.x += n.vx;
        n.y += n.vy;
        totalKineticEnergy += n.vx * n.vx + n.vy * n.vy;
      });

      // park the simulation when the layout is quiet to save CPU.
      // Pick up again when a drag/interaction wakes the loop.
      var rmsVelocity = nodes.length > 0 ? Math.sqrt(totalKineticEnergy / nodes.length) : 0;
      if (rmsVelocity < 0.05 && graphSim.tickCount > 60 && !graphSim.dragNode) {
        graphSim.quietTicks = (graphSim.quietTicks || 0) + 1;
      } else {
        graphSim.quietTicks = 0;
      }

      renderGraph();
      if (graphSim.quietTicks > 30) {
        graphSim.raf = null;
        return;
      }
      graphSim.raf = requestAnimationFrame(runSimulation);
    }

    async function rebuildGraph() {
      var sb = document.getElementById('graph-sidebar');
      if (sb) sb.innerHTML = '<h3>关系图</h3><p style="font-size:12px;color:var(--ink-faint);font-style:italic;">正在根据观察重建关系图...</p>';
      await apiPost('graph/build', {});
      state.graph.loaded = false;
      loadGraph();
    }

    function drawNodeShape(ctx, x, y, r, type) {
      var shape = NODE_SHAPES[type] || 'circle';
      switch(shape) {
        case 'rect':
          ctx.beginPath();
          ctx.rect(x - r, y - r * 0.75, r * 2, r * 1.5);
          break;
        case 'diamond':
          ctx.beginPath();
          ctx.moveTo(x, y - r);
          ctx.lineTo(x + r, y);
          ctx.lineTo(x, y + r);
          ctx.lineTo(x - r, y);
          ctx.closePath();
          break;
        case 'hexagon':
          ctx.beginPath();
          for (var i = 0; i < 6; i++) {
            var angle = (Math.PI / 3) * i - Math.PI / 2;
            var hx = x + r * Math.cos(angle);
            var hy = y + r * Math.sin(angle);
            if (i === 0) ctx.moveTo(hx, hy); else ctx.lineTo(hx, hy);
          }
          ctx.closePath();
          break;
        default:
          ctx.beginPath();
          ctx.arc(x, y, r, 0, Math.PI * 2);
          break;
      }
    }

    function renderGraph() {
      var ctx = graphSim.ctx;
      var canvas = graphSim.canvas;
      if (!ctx || !canvas) return;
      var w = canvas.width / window.devicePixelRatio;
      var h = canvas.height / window.devicePixelRatio;

      ctx.clearRect(0, 0, w, h);

      // --- Canvas grid background ---
      var gridSize = 24;
      ctx.save();
      ctx.strokeStyle = isDarkMode() ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.04)';
      ctx.lineWidth = 0.5;
      for (var gx = 0; gx < w; gx += gridSize) {
        ctx.beginPath(); ctx.moveTo(gx, 0); ctx.lineTo(gx, h); ctx.stroke();
      }
      for (var gy = 0; gy < h; gy += gridSize) {
        ctx.beginPath(); ctx.moveTo(0, gy); ctx.lineTo(w, gy); ctx.stroke();
      }
      ctx.restore();

      ctx.save();
      ctx.translate(graphSim.panX, graphSim.panY);
      ctx.scale(graphSim.zoom, graphSim.zoom);

      var nodeMap = {};
      graphSim.nodes.forEach(function(n) { nodeMap[n.id] = n; });

      var searchActive = graphSearchTerm.length > 0;
      var totalVisible = graphSim.nodes.filter(function(n) { return state.graph.filters[n.type]; }).length;
      var isDense = totalVisible > 40;
      var labelZoomThreshold = isDense ? 1.5 : 0.5;
      var edgeLabelZoomThreshold = isDense ? 2.5 : 1.2;
      var selectedId = state.graph.selectedNode ? state.graph.selectedNode.id : null;

      // --- Hover node detection for focus effect ---
      var hoverNodeId = null;
      if (!graphSim.dragNode && graphSim.canvas) {
        var rect = graphSim.canvas.getBoundingClientRect();
        var hx = (graphSim.mouseX - rect.left - graphSim.panX) / graphSim.zoom;
        var hy = (graphSim.mouseY - rect.top - graphSim.panY) / graphSim.zoom;
        for (var hi = graphSim.nodes.length - 1; hi >= 0; hi--) {
          var hn = graphSim.nodes[hi];
          if (!state.graph.filters[hn.type]) continue;
          var hdx = hn.x - hx, hdy = hn.y - hy;
          if (hdx * hdx + hdy * hdy < hn.r * hn.r + 25) { hoverNodeId = hn.id; break; }
        }
      }
      var focusNodeId = selectedId || hoverNodeId;

      // --- Draw edges ---
      graphSim.edges.forEach(function(e) {
        var s = nodeMap[e.sourceNodeId];
        var t = nodeMap[e.targetNodeId];
        if (!s || !t) return;
        if (!state.graph.filters[s.type] || !state.graph.filters[t.type]) return;

        var edgeDimmed = searchActive && !(s.name.toLowerCase().includes(graphSearchTerm) || t.name.toLowerCase().includes(graphSearchTerm));
        var isConnectedToFocus = focusNodeId && (e.sourceNodeId === focusNodeId || e.targetNodeId === focusNodeId);
        var isFocusActive = focusNodeId !== null;
        var weight = typeof e.weight === 'number' ? e.weight : 0.5;
        var lineWidth = isConnectedToFocus ? 2 + weight * 2 : 1 + weight * 1.5;

        var dx = t.x - s.x;
        var dy = t.y - s.y;
        var len = Math.sqrt(dx * dx + dy * dy) || 1;
        var curveOffset = isDense ? 12 : 18;
        var offsetX = -dy / len * curveOffset;
        var offsetY = dx / len * curveOffset;
        var cpx = (s.x + t.x) / 2 + offsetX;
        var cpy = (s.y + t.y) / 2 + offsetY;

        // Colored edges based on source node type
        var edgeColor = NODE_COLORS[s.type] || '#666666';
        var edgeAlpha;
        if (edgeDimmed) {
          edgeAlpha = 0.06;
        } else if (isFocusActive && isConnectedToFocus) {
          edgeAlpha = 0.65;
        } else if (isFocusActive && !isConnectedToFocus) {
          edgeAlpha = 0.06;
        } else {
          edgeAlpha = isDense ? 0.15 : 0.25;
        }

        ctx.beginPath();
        ctx.moveTo(s.x, s.y);
        ctx.quadraticCurveTo(cpx, cpy, t.x, t.y);
        // Parse hex color to rgba
        var r = parseInt(edgeColor.slice(1,3), 16);
        var g = parseInt(edgeColor.slice(3,5), 16);
        var b = parseInt(edgeColor.slice(5,7), 16);
        ctx.strokeStyle = 'rgba(' + r + ',' + g + ',' + b + ',' + edgeAlpha + ')';
        ctx.lineWidth = lineWidth;
        ctx.stroke();

        if (!isDense || isConnectedToFocus) {
          var arrowAngle = Math.atan2(t.y - cpy, t.x - cpx);
          var arrowLen = 5 + lineWidth;
          ctx.beginPath();
          ctx.moveTo(t.x - t.r * Math.cos(arrowAngle), t.y - t.r * Math.sin(arrowAngle));
          ctx.lineTo(t.x - (t.r + arrowLen) * Math.cos(arrowAngle - 0.3), t.y - (t.r + arrowLen) * Math.sin(arrowAngle - 0.3));
          ctx.lineTo(t.x - (t.r + arrowLen) * Math.cos(arrowAngle + 0.3), t.y - (t.r + arrowLen) * Math.sin(arrowAngle + 0.3));
          ctx.closePath();
          ctx.fillStyle = 'rgba(' + r + ',' + g + ',' + b + ',' + (edgeDimmed ? 0.06 : isConnectedToFocus ? 0.6 : 0.2) + ')';
          ctx.fill();
        }

        var showEdgeLabel = e.type && !edgeDimmed && (isConnectedToFocus ? graphSim.zoom > 0.6 : graphSim.zoom > edgeLabelZoomThreshold);
        if (showEdgeLabel) {
          var zoomInv = 1 / graphSim.zoom;
          ctx.save();
          ctx.fillStyle = isDarkMode() ? (isConnectedToFocus ? 'rgba(238,238,238,0.9)' : 'rgba(180,180,180,0.7)') : (isConnectedToFocus ? 'rgba(17,17,17,0.85)' : 'rgba(80,80,80,0.7)');
          ctx.font = (isConnectedToFocus ? '600 ' : '500 ') + (11 * zoomInv).toFixed(1) + 'px Inter, sans-serif';
          ctx.textAlign = 'center';
          ctx.fillText(e.type, cpx, cpy - (4 * zoomInv));
          ctx.restore();
        }
      });

      // --- Draw nodes ---
      graphSim.nodes.forEach(function(n) {
        if (!state.graph.filters[n.type]) return;
        var color = NODE_COLORS[n.type] || '#666666';
        var isSelected = selectedId === n.id;
        var isHovered = hoverNodeId === n.id;
        var matchesSearch = !searchActive || n.name.toLowerCase().includes(graphSearchTerm);
        var isFocusFaded = focusNodeId && n.id !== focusNodeId && !graphSim.edges.some(function(ed) {
          return (ed.sourceNodeId === focusNodeId && ed.targetNodeId === n.id) ||
                 (ed.targetNodeId === focusNodeId && ed.sourceNodeId === n.id);
        });

        var nodeAlpha = !matchesSearch ? 0.12 : (isFocusFaded ? 0.2 : 1);

        ctx.save();
        ctx.globalAlpha = nodeAlpha;

        // Glow effect
        if (matchesSearch && !isFocusFaded && (isSelected || isHovered || !searchActive)) {
          ctx.shadowColor = color;
          ctx.shadowBlur = isSelected ? 20 : isHovered ? 16 : (isDense ? 4 : 8);
        }

        // Gradient fill
        drawNodeShape(ctx, n.x, n.y, n.r, n.type);
        var grad = ctx.createRadialGradient(n.x - n.r * 0.3, n.y - n.r * 0.3, 0, n.x, n.y, n.r * 1.2);
        var cr = parseInt(color.slice(1,3), 16);
        var cg = parseInt(color.slice(3,5), 16);
        var cb = parseInt(color.slice(5,7), 16);
        grad.addColorStop(0, 'rgba(' + Math.min(255, cr + 60) + ',' + Math.min(255, cg + 60) + ',' + Math.min(255, cb + 60) + ',0.95)');
        grad.addColorStop(1, color);
        ctx.fillStyle = grad;
        ctx.fill();
        ctx.restore();

        // Selected ring
        if (isSelected) {
          ctx.save();
          drawNodeShape(ctx, n.x, n.y, n.r + 3, n.type);
          ctx.strokeStyle = color;
          ctx.lineWidth = 3;
          ctx.shadowColor = color;
          ctx.shadowBlur = 12;
          ctx.stroke();
          ctx.restore();
        } else if (isHovered) {
          drawNodeShape(ctx, n.x, n.y, n.r + 2, n.type);
          ctx.strokeStyle = color;
          ctx.lineWidth = 2;
          ctx.stroke();
        } else if (searchActive && matchesSearch) {
          drawNodeShape(ctx, n.x, n.y, n.r, n.type);
          ctx.strokeStyle = '#CC0000';
          ctx.lineWidth = 2;
          ctx.stroke();
        }

        var showLabel = matchesSearch && !isFocusFaded && (
          isSelected || isHovered ||
          (searchActive && matchesSearch) ||
          (!isDense && graphSim.zoom > labelZoomThreshold) ||
          (isDense && graphSim.zoom > labelZoomThreshold && n.r > 10)
        );
        if (showLabel) {
          var zoomInv = 1 / graphSim.zoom;
          ctx.save();
          ctx.font = (isSelected || isHovered ? '600 ' : '500 ') + (13 * zoomInv).toFixed(1) + 'px Inter, sans-serif';
          ctx.textAlign = 'center';
          
          var label = truncate(n.name, 18);
          var textW = ctx.measureText(label).width;
          var labelW = textW + (16 * zoomInv);
          var labelH = 20 * zoomInv;
          var labelY = n.y + n.r + (8 * zoomInv); // Top of the background pill
          
          ctx.fillStyle = isDarkMode() ? 'rgba(30,30,35,0.92)' : 'rgba(255,255,255,0.92)';
          ctx.beginPath();
          ctx.roundRect ? ctx.roundRect(n.x - labelW / 2, labelY, labelW, labelH, 4 * zoomInv) : ctx.rect(n.x - labelW / 2, labelY, labelW, labelH);
          ctx.fill();
          
          ctx.strokeStyle = isDarkMode() ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)';
          ctx.lineWidth = 1 * zoomInv;
          ctx.stroke();

          ctx.fillStyle = isDarkMode() ? (isSelected || isHovered ? '#eeeeee' : '#bbbbbb') : (isSelected || isHovered ? '#111111' : '#444444');
          // Vertically center text in the pill box
          ctx.fillText(label, n.x, labelY + (14 * zoomInv));
          ctx.restore();
        }
      });

      ctx.restore();

      if (graphSim.nodes.length === 0) {
        ctx.fillStyle = '#999999';
        ctx.font = '14px Lora, Georgia, serif';
        ctx.textAlign = 'center';
        ctx.fillText('暂无关系图数据', w / 2, h / 2 - 16);
        ctx.font = '12px Inter, sans-serif';
        ctx.fillText('Set GRAPH_EXTRACTION_ENABLED=true to enable knowledge graph extraction.', w / 2, h / 2 + 8);
      }
    }

    async function loadMemories() {
      var el = document.getElementById('view-memories');
      el.innerHTML = '<div class="loading">加载记忆中...</div>';
      // cap at 2000 so the viewer remains responsive on large
      // corpora. Older endpoints returned the full unbounded list which
      // hit the iii invocation timeout and the UI fell through to 0.
      var result = await apiGet('memories?latest=true&limit=2000');
      var items = (result && result.memories) || [];
      // Newest first — server returns KV-insertion order.
      items.sort(function(a, b) {
        var ac = (a && a.createdAt) || (a && a.updatedAt) || '';
        var bc = (b && b.createdAt) || (b && b.updatedAt) || '';
        return bc.localeCompare(ac);
      });
      state.memories.items = items;
      state.memories.reviewItems = [];
      state.memories.total = (result && typeof result.total === 'number') ? result.total : items.length;
      state.memories.loaded = true;
      renderMemories();
    }

    function renderMemories() {
      var el = document.getElementById('view-memories');
      var items = state.memories.items;
      var search = state.memories.search.toLowerCase();
      var typeFilter = state.memories.typeFilter;
      var sourceFilter = state.memories.sourceFilter || '';

      var filtered = items.filter(function(m) {
        if (typeFilter && m.type !== typeFilter) return false;
        if (sourceFilter) {
          if (sourceFilter.indexOf('browser:') === 0) {
            if (memorySourceKind(m) !== 'browser') return false;
            if (browserSourceFromMemory(m) !== sourceFilter.slice('browser:'.length)) return false;
          } else if (memorySourceKind(m) !== sourceFilter) {
            return false;
          }
        }
        const normalizedSearch = (search || '')
          .normalize("NFKC")
          .toLowerCase();
 
        const normalizedTitle = (m.title || '')
          .normalize("NFKC")
          .toLowerCase();

        const normalizedContent = (m.content || '')
          .normalize("NFKC")
          .toLowerCase();

        if (
          search &&
          !normalizedTitle.includes(normalizedSearch) &&
          !normalizedContent.includes(normalizedSearch)
        ) {
        return false;
        }

        return true;
      });

      var types = {};
      items.forEach(function(m) { types[m.type] = true; });
      var typeOptions = Object.keys(types).sort();
      var displayGroups = {};
      var displayCount = 0;
      filtered.forEach(function(m) {
        var cat = memoryCategory(m);
        var cards = memoryDisplayCards(m);
        if (!displayGroups[cat]) displayGroups[cat] = [];
        cards.forEach(function(card) {
          displayGroups[cat].push(card);
          displayCount += 1;
        });
      });

      var html = '';

      html += '<div class="toolbar memory-toolbar">';
      html += '<button class="btn btn-primary add-memory-btn" data-action="open-add-memory" aria-label="整理会话">';
      html += '<svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>';
      html += '整理会话</button>';
      html += '<div class="memory-search-wrap' + (state.memories.search ? ' has-search' : '') + '">';
      html += '<svg viewBox="0 0 24 24" fill="none" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M16.5 16.5 21 21"/></svg>';
      html += '<input class="memory-search-input" type="text" id="mem-search" aria-label="搜索记忆" placeholder="搜索记忆..." value="' + esc(state.memories.search) + '">';
      html += '</div>';
      html += '<select id="mem-type-filter"><option value="">全部类型</option>';
      typeOptions.forEach(function(t) {
        html += '<option value="' + esc(t) + '"' + (typeFilter === t ? ' selected' : '') + '>' + esc(t) + '</option>';
      });
      html += '</select>';
      html += '<select id="mem-source-filter" aria-label="筛选来源"><option value="">全部来源</option>';
      [['browser', '浏览器'], ['browser:chatgpt', 'ChatGPT'], ['browser:claude', 'Claude'], ['browser:gemini', 'Gemini'], ['browser:perplexity', 'Perplexity'], ['browser:grok', 'Grok'], ['browser:deepseek', 'DeepSeek'], ['session', '会话'], ['manual', '手动']].forEach(function(item) {
        html += '<option value="' + item[0] + '"' + (sourceFilter === item[0] ? ' selected' : '') + '>' + item[1] + '</option>';
      });
      html += '</select></div>';

      html += '<div class="memory-summary" style="background:#ffffff;margin-bottom:14px;">';
      html += '<div><div class="memory-summary-title">自动整理中</div><div class="memory-summary-sub">新的聊天记录会作为记忆线索；你可以在这里审阅、编辑或删除。</div></div>';
      html += '</div>';

      if (filtered.length === 0) {
        html += '<div class="empty-state">' +
          '<div class="empty-icon icon icon-book"></div>' +
          '<div class="empty-title">还没有记忆</div>' +
          '<div class="empty-lead">当 Agent 记录事实、偏好、项目和工作方式后，会在这里按主题归档。</div>' +
          '</div>';
      } else {
        var order = ['身份档案', '偏好', '项目与目标', '判断框架', '经历'];
        Object.keys(displayGroups).forEach(function(k) { if (order.indexOf(k) < 0) order.push(k); });
        html += '<div style="display:grid;gap:12px;">';
        order.forEach(function(cat) {
          var cards = displayGroups[cat];
          if (!cards || !cards.length) return;
          html += '<section class="card memory-section" style="padding:14px 16px;">';
          html += '<div class="memory-section-head">';
          html += '<div class="memory-section-title">' + esc(cat) + '</div>';
          if (cat !== '身份档案') html += '<span class="memory-section-count">' + cards.length + ' 张卡片</span>';
          html += '</div>';
          if (cat === '身份档案') {
            html += renderIdentityProfileGroup(cards);
          } else {
            html += '<div class="memory-card-grid">';
            cards.forEach(function(card) {
              html += renderMemoryCard(card);
            });
            html += '</div>';
          }
          html += '</section>';
        });
        html += '</div>';
      }

      var __focus = captureSearchFocus(['mem-search']);
      el.innerHTML = html;

      var searchInput = document.getElementById('mem-search');
      if (searchInput) {
        bindImeSafeSearch(searchInput, 200, function(v){ state.memories.search = v; renderMemories(); });
      }
      var typeSelect = document.getElementById('mem-type-filter');
      if (typeSelect) {
        typeSelect.addEventListener('change', function() {
          state.memories.typeFilter = this.value;
          renderMemories();
        });
      }
      var sourceSelect = document.getElementById('mem-source-filter');
      if (sourceSelect) {
        sourceSelect.addEventListener('change', function() {
          state.memories.sourceFilter = this.value;
          renderMemories();
        });
      }
      restoreSearchFocus(__focus);
    }

    function deleteMemory(id, title) {
      var modal = document.getElementById('modal');
      var overlay = document.getElementById('modal-overlay');
      modal.innerHTML = '<h3>删除记忆</h3><p>确认删除「' + esc(title) + '」吗？此操作不可撤销。</p><div class="modal-actions"><button class="btn" data-action="close-modal">取消</button><button class="btn btn-danger" data-action="confirm-delete-memory" data-memory-id="' + esc(id) + '">删除</button></div>';
      overlay.classList.add('open');
    }

    function openAddMemory() {
      var modal = document.getElementById('modal');
      var overlay = document.getElementById('modal-overlay');
      modal.innerHTML =
        '<h3>补充记忆线索</h3>' +
        '<p>记忆会优先从聊天记录自动整理；这里用于补充那些没有在会话里说清楚、但希望 Agent 记住的内容。</p>' +
        '<div class="memory-add-form">' +
        '<label>线索内容<textarea id="add-memory-content" rows="7" placeholder="例如：以后创建新产品时，先给我看图片预览，再讨论技术实现。"></textarea></label>' +
        '<div class="memory-add-grid">' +
        '<label>放入位置<select id="add-memory-area"><option value="profile">身份档案</option><option value="preference">偏好</option><option value="project">项目与目标</option><option value="principle">判断框架</option><option value="history">经历</option></select></label>' +
        '<label>关联文件夹<input id="add-memory-project" placeholder="可选"></label>' +
        '</div>' +
        '<div id="add-memory-error" class="memory-form-error"></div>' +
        '</div>' +
        '<div class="modal-actions"><button class="btn" data-action="close-modal">取消</button><button class="btn btn-primary" data-action="save-new-memory">保存</button></div>';
      overlay.classList.add('open');
      setTimeout(function() {
        var input = document.getElementById('add-memory-content');
        if (input) input.focus();
      }, 0);
    }

    async function saveNewMemory() {
      var err = document.getElementById('add-memory-error');
      var content = (document.getElementById('add-memory-content') || {}).value || '';
      var area = (document.getElementById('add-memory-area') || {}).value || '';
      var project = (document.getElementById('add-memory-project') || {}).value || '';
      if (!content.trim()) {
        if (err) {
          err.style.display = 'block';
          err.textContent = '先写一点内容再保存。';
        }
        return;
      }
      var result = await apiPost('remember', {
        content: content.trim(),
        type: memoryAreaToType(area),
        project: project.trim() || undefined
      });
      if (!result || result.error) {
        if (err) {
          err.style.display = 'block';
          err.textContent = (result && result.error) || '保存失败，请稍后再试。';
        }
        return;
      }
      closeModal();
      state.memories.loaded = false;
      await loadMemories();
    }

    function editMemory(id) {
      var mem = (state.memories.items || []).find(function(m) { return m.id === id; });
      if (!mem) return;
      var modal = document.getElementById('modal');
      var overlay = document.getElementById('modal-overlay');
      var area = memoryTypeToArea(mem.type, mem);
      var isProfile = area === 'profile';
      modal.innerHTML =
        '<h3>' + (isProfile ? '完善档案' : '编辑记忆') + '</h3>' +
        '<p>' + (isProfile ? '这里会影响身份档案的完整呈现。建议按“基本信息、当前重点、沟通偏好、常用表达”补充。' : '调整内容和它在记忆库里的位置。') + '</p>' +
        '<div class="memory-add-form">' +
        '<label>标题<input id="edit-memory-title" value="' + esc(mem.title || '') + '"></label>' +
        '<div class="memory-add-grid">' +
        '<label>放入位置<select id="edit-memory-area">' +
          '<option value="profile"' + (area === 'profile' ? ' selected' : '') + '>身份档案</option>' +
          '<option value="preference"' + (area === 'preference' ? ' selected' : '') + '>偏好</option>' +
          '<option value="project"' + (area === 'project' ? ' selected' : '') + '>项目与目标</option>' +
          '<option value="principle"' + (area === 'principle' ? ' selected' : '') + '>判断框架</option>' +
          '<option value="history"' + (area === 'history' ? ' selected' : '') + '>经历</option>' +
        '</select></label>' +
        '<label>关联文件夹<input id="edit-memory-project" value="' + esc(mem.project || '') + '" placeholder="可选"></label>' +
        '</div>' +
        '<label>记忆内容<textarea id="edit-memory-content" rows="9">' + esc(mem.content || '') + '</textarea></label>' +
        '<div id="edit-memory-error" class="memory-form-error"></div>' +
        '</div>' +
        '<div class="modal-actions"><button class="btn" data-action="close-modal">取消</button><button class="btn btn-primary" data-action="save-memory" data-memory-id="' + esc(id) + '">保存</button></div>';
      overlay.classList.add('open');
    }

    async function saveMemory(id) {
      var err = document.getElementById('edit-memory-error');
      var title = (document.getElementById('edit-memory-title') || {}).value || '';
      var area = (document.getElementById('edit-memory-area') || {}).value || '';
      var project = (document.getElementById('edit-memory-project') || {}).value || '';
      var content = (document.getElementById('edit-memory-content') || {}).value || '';
      if (!content.trim()) {
        if (err) {
          err.style.display = 'block';
          err.textContent = '内容不能为空。';
        }
        return;
      }
      var result = await apiPatch('memories/' + encodeURIComponent(id), {
        title: title.trim(),
        type: memoryAreaToType(area),
        project: project.trim(),
        content: content.trim()
      });
      if (!result || result.error) {
        if (err) {
          err.style.display = 'block';
          err.textContent = (result && result.error) || '保存失败，请稍后再试。';
        }
        return;
      }
      closeModal();
      state.memories.loaded = false;
      await loadMemories();
    }

    async function confirmDeleteMemory(id) {
      closeModal();
      await apiDelete('governance/memories', { memoryIds: [id], reason: 'Deleted via viewer' });
      state.memories.loaded = false;
      loadMemories();
    }

    function editReviewItem(id) {
      var item = (state.memories.reviewItems || []).filter(isReviewItemDisplayable).find(function(x) { return x.id === id; }) ||
        (state.actions.reviewItems || []).filter(isReviewItemDisplayable).find(function(x) { return x.id === id; });
      if (!item) return;
      var payload = item.payload || {};
      var isAction = item.kind === 'action';
      var sourceLabel = reviewSourceLabel(item);
      var defaultTags = reviewTags(item).length ? reviewTags(item).join(', ') : ['browser', 'reviewed', payload.provider ? 'source:' + String(payload.provider).toLowerCase() : '', item.page && item.page.type ? 'page:' + item.page.type : ''].filter(Boolean).join(', ');
      var defaultProject = reviewProject(item);
      var modal = document.getElementById('modal');
      var overlay = document.getElementById('modal-overlay');
      modal.innerHTML =
        '<h3>审阅后保存</h3>' +
        '<p>这条内容来自 ' + esc(sourceLabel) + '。确认前可以调整标题、内容和归属，避免临时信息直接进入待办列表。</p>' +
        '<div class="memory-add-form">' +
        '<label>标题<input id="review-title" value="' + esc(item.title || '') + '"></label>' +
        '<label>内容<textarea id="review-content" rows="8">' + esc(item.content || '') + '</textarea></label>' +
        '<div class="memory-add-grid">' +
        '<label>类型<select id="review-kind"><option value="action" selected>行动候选</option></select></label>' +
        '<label>项目<input id="review-project" value="' + esc(defaultProject) + '"></label>' +
        '</div>' +
        '<div class="memory-add-grid">' +
        (isAction ? '<label>优先级<input id="review-priority" type="number" min="1" max="10" value="' + esc(reviewActionPriority(item)) + '"></label>' : '<label>记忆类型<select id="review-type"><option value="fact"' + (payload.type === 'fact' || !payload.type ? ' selected' : '') + '>事实</option><option value="preference"' + (payload.type === 'preference' ? ' selected' : '') + '>偏好</option><option value="workflow"' + (payload.type === 'workflow' ? ' selected' : '') + '>工作流</option><option value="pattern"' + (payload.type === 'pattern' ? ' selected' : '') + '>模式</option><option value="architecture"' + (payload.type === 'architecture' ? ' selected' : '') + '>架构</option><option value="bug"' + (payload.type === 'bug' ? ' selected' : '') + '>问题</option></select></label>') +
        '<label>标签<input id="review-tags" value="' + esc(defaultTags) + '"></label>' +
        '</div>' +
        '<div id="review-error" class="memory-form-error"></div>' +
        '</div>' +
        '<div class="modal-actions"><button class="btn" data-action="close-modal">取消</button><button class="btn btn-primary" data-action="approve-review" data-review-id="' + esc(id) + '">确认写入</button></div>';
      overlay.classList.add('open');
    }

    async function approveReviewItem(id) {
      var fromActionsReview = (state.actions.reviewItems || []).some(function(x) { return x.id === id; });
      var err = document.getElementById('review-error');
      var title = (document.getElementById('review-title') || {}).value || '';
      var content = (document.getElementById('review-content') || {}).value || '';
      var kind = (document.getElementById('review-kind') || {}).value || 'memory';
      var project = (document.getElementById('review-project') || {}).value || '';
      var type = (document.getElementById('review-type') || {}).value || 'fact';
      var priority = parseInt((document.getElementById('review-priority') || {}).value || '', 10);
      var tags = (document.getElementById('review-tags') || {}).value || '';
      if (!content.trim()) {
        if (err) {
          err.style.display = 'block';
          err.textContent = '内容不能为空。';
        }
        return;
      }
      var result = await apiPost('review/approve', {
        id: id,
        title: title.trim(),
        content: content.trim(),
        kind: kind,
        project: project.trim() || undefined,
        type: type,
        priority: Number.isFinite(priority) ? priority : undefined,
        tags: tags
      });
      if (!result || result.error) {
        if (err) {
          err.style.display = 'block';
          err.textContent = (result && result.error) || '写入失败，请稍后再试。';
        }
        return;
      }
      closeModal();
      state.memories.loaded = false;
      if (state.activeTab === 'actions' || fromActionsReview) {
        state.actions.loaded = false;
        await loadActions();
      } else {
        await loadMemories();
      }
    }

    async function dismissReviewItem(id) {
      var fromActionsReview = (state.actions.reviewItems || []).some(function(x) { return x.id === id; });
      await apiPost('review/dismiss', { id: id });
      state.memories.reviewItems = (state.memories.reviewItems || []).filter(function(x) { return x.id !== id; });
      state.actions.reviewItems = (state.actions.reviewItems || []).filter(function(x) { return x.id !== id; });
      if (state.activeTab === 'actions' || fromActionsReview) {
        renderActions();
      } else {
        renderMemories();
      }
    }

    function closeModal() {
      document.getElementById('modal-overlay').classList.remove('open');
    }

    async function loadTimeline() {
      var el = document.getElementById('view-timeline');
      el.innerHTML = '<div class="loading">加载时间线中...</div>';
      var sessResult = await apiGet('sessions');
      var localSessions = await loadLocalCodexSessions(120);
      var sessions = mergeSessions(((sessResult && sessResult.sessions) || []), localSessions).filter(function(s) { return !isDemoSession(s); });
      state.timeline.sessions = sessions;
      state.timeline.loaded = true;

      var groups = groupSessionsByProject(sessions);
      if (groups.length > 0 && !state.timeline.projectKey) {
        state.timeline.projectKey = groups[0].key;
      }

      renderTimelineToolbar(groups);
      if (state.timeline.projectKey) await loadObservations();
    }

    function renderTimelineToolbar(groups) {
      var el = document.getElementById('view-timeline');
      groups = (groups || []).map(function(g) {
        return g && g.sessions ? g : groupSessionsByProject([g])[0];
      }).filter(Boolean);
      var html = '<div class="toolbar">';
      html += '<select id="tl-project"><option value="">选择文件夹</option>';
      groups.forEach(function(g) {
        html += '<option value="' + esc(g.key) + '"' + (state.timeline.projectKey === g.key ? ' selected' : '') + '>' + esc(g.name) + ' · ' + g.count + ' 段</option>';
      });
      html += '</select>';
	      html += '<span class="mode-switch" aria-label="时间线显示模式">';
	      html += '<button type="button" class="' + (state.timeline.mode === 'episodes' ? 'active' : '') + '" data-action="timeline-mode" data-mode="episodes">故事模式</button>';
	      html += '<button type="button" class="' + (state.timeline.mode === 'events' ? 'active' : '') + '" data-action="timeline-mode" data-mode="events">事件模式</button>';
	      html += '</span></div>';
      html += '<div id="tl-content"></div>';
      el.innerHTML = html;

      document.getElementById('tl-project').addEventListener('change', function() {
        state.timeline.projectKey = this.value;
        state.timeline.sessionId = '';
        state.timeline.page = 0;
        loadObservations();
      });
    }

    async function loadObservations() {
      var content = document.getElementById('tl-content');
      if (!content) return;
      if (!state.timeline.projectKey) {
        content.innerHTML = '<div class="empty-state"><div class="empty-icon">&#128337;</div><p>请选择一个文件夹查看时间线</p></div>';
        return;
      }
      content.innerHTML = '<div class="loading">加载观察记录中...</div>';
      var sessions = (state.timeline.sessions || []).filter(function(s) { return sessionProjectKey(s) === state.timeline.projectKey && sessionId(s); });
      var localOnly = sessions.every(function(s) { return String(s.source || '') === 'local-codex-jsonl'; });
      if (localOnly) {
        state.timeline.observations = sessions.map(function(s) {
          return {
            id: sessionId(s),
            sessionId: sessionId(s),
            timestamp: sessionRecordTime(s),
            type: 'conversation',
            title: sessionTitleText(s) || 'Codex 会话',
            narrative: sessionBodyPreview(s, sessionTitleText(s)),
            importance: 5,
            _sessionId: sessionId(s),
            _sessionName: sessionDisplayName(s)
          };
        }).sort(function(a, b) {
          return String(b.timestamp || '').localeCompare(String(a.timestamp || ''));
        });
        renderObservations();
        return;
      }
      var results = await Promise.all(sessions.map(function(s) {
        return apiGet('observations?sessionId=' + encodeURIComponent(sessionId(s))).then(function(result) {
          var list = (result && result.observations) || [];
          return list.map(function(o) {
            o._sessionId = sessionId(s);
            o._sessionName = sessionDisplayName(s);
            return o;
          });
        }).catch(function() { return []; });
      }));
      state.timeline.observations = results.reduce(function(acc, list) { return acc.concat(list); }, []).sort(function(a, b) {
        return String(b.timestamp || '').localeCompare(String(a.timestamp || ''));
      });
      renderObservations();
    }

    var tlTypeFilter = '';

    function renderObservations() {
      var content = document.getElementById('tl-content');
	      if (!content) return;
	      var obs = state.timeline.observations;
	      var minImp = state.timeline.minImportance;
	      var filtered = minImp > 0 ? obs.filter(function(o) { return (o.importance || 0) >= minImp; }) : obs;
	      var html = '';

		      var typeCounts = {};
	      filtered.forEach(function(o) {
	        var t = observationType(o);
	        typeCounts[t] = (typeCounts[t] || 0) + 1;
	      });
      var typeList = Object.keys(typeCounts).sort(function(a, b) { return typeCounts[b] - typeCounts[a]; });

	      if (tlTypeFilter) {
	        filtered = filtered.filter(function(o) {
	          var t = observationType(o);
	          return t === tlTypeFilter;
	        });
	      }

	      var pageSize = state.timeline.pageSize;
	      var page = state.timeline.page;

	      if (state.timeline.mode === 'episodes') {
	        var allEpisodes = buildTimelineEpisodes(filtered);
	        var episodeFilter = state.timeline.episodeFilter || 'all';
	        var filterCounts = { all: allEpisodes.length, important: 0 };
	        allEpisodes.forEach(function(ep) {
	          if (ep.kind === 'important' || ep.kind === 'user_need' || ep.kind === 'bugfix') filterCounts.important++;
	        });
	        html += '<div class="type-chips" style="margin-bottom:12px;">';
	        [
	          ['all', '全部'],
	          ['important', '重点']
	        ].forEach(function(item) {
	          var key = item[0];
	          var label = item[1];
	          html += '<span class="type-chip' + (episodeFilter === key ? ' active' : '') + '" data-action="episode-filter" data-episode-filter="' + key + '">' + label + ' (' + (filterCounts[key] || 0) + ')</span>';
	        });
	        html += '</div>';
	        var episodes = filterTimelineEpisodes(allEpisodes);
	        var epPageSize = Math.max(10, Math.floor(pageSize / 2));
	        var epPage = page;
	        var epStart = epPage * epPageSize;
	        var epPaged = episodes.slice(epStart, epStart + epPageSize);
	        var epTotalPages = Math.ceil(episodes.length / epPageSize);
	        html += '<div style="font-size:12px;color:var(--ink-secondary);margin-bottom:16px;line-height:1.6;">故事模式会把同一段工作里的底层记录合并成可读片段。需要看完整流水时，可以切到事件模式。</div>';
	        if (epPaged.length === 0) {
	          html += '<div class="empty-state"><div class="empty-icon">&#128337;</div><p>暂无可整理的工作片段</p></div>';
	          content.innerHTML = html;
	          return;
	        }
		        epPaged.forEach(function(ep) {
		          var accent = ep.importance >= 7 ? OBS_TYPE_COLORS.decision : ep.importance >= 4 ? OBS_TYPE_COLORS.discovery : OBS_TYPE_COLORS.other;
		          var expanded = !!state.timeline.expandedEpisodes[ep.key];
		          var visibleActions = expanded ? ep.actions : ep.actions.slice(0, 2);
		          html += '<div class="episode-card' + (expanded ? ' expanded' : '') + '" style="border-left-color:' + accent + ';">';
		          html += '<div class="episode-kind">' + esc(episodeKindLabel(ep.kind)) + '</div>';
		          html += '<div class="episode-title">' + esc(ep.title) + '</div>';
		          html += '<div class="episode-meta">';
	          html += '<span>' + esc(formatTime(ep.start)) + (ep.end && ep.end !== ep.start ? ' - ' + esc(shortTime(ep.end)) : '') + '</span>';
	          html += '<span>' + ep.count + ' 条记录</span>';
	          html += '<span>' + esc(ep.typeText) + '</span>';
		          html += '</div>';
		          html += '<div class="episode-body">' + esc(ep.body) + '</div>';
		          if (visibleActions.length > 0) {
		            html += '<ul class="episode-actions">';
		            visibleActions.forEach(function(a) { html += '<li>' + esc(a) + '</li>'; });
		            html += '</ul>';
		          }
		          html += '<div class="episode-footer">';
		          html += '<span style="font-size:11px;color:var(--ink-faint);">' + (ep.actions.length > 2 ? '还有 ' + (ep.actions.length - 2) + ' 条细节' : '细节已完整展示') + '</span>';
		          if (ep.actions.length > 2) html += '<button class="btn" data-action="episode-toggle" data-episode-key="' + esc(ep.key) + '">' + (expanded ? '收起细节' : '展开细节') + '</button>';
		          html += '</div>';
		          html += '</div>';
		        });
	        if (epTotalPages > 1) {
	          html += '<div class="pagination">';
	          if (epPage > 0) html += '<button class="btn" data-action="timeline-page" data-page="' + (epPage - 1) + '">上一页</button>';
	          html += '<span style="color:var(--ink-faint);font-size:12px;padding:6px;font-family:var(--font-mono);">第 ' + (epPage + 1) + ' / ' + epTotalPages + ' 页（共 ' + episodes.length + ' 段）</span>';
	          if (epPage < epTotalPages - 1) html += '<button class="btn" data-action="timeline-page" data-page="' + (epPage + 1) + '">下一页</button>';
	          html += '</div>';
	        }
	        content.innerHTML = html;
	        return;
	      }

	      var start = page * pageSize;
      var paged = filtered.slice(start, start + pageSize);
      var totalPages = Math.ceil(filtered.length / pageSize);

	      html += '<div class="type-chips">';
      html += '<span class="type-chip' + (!tlTypeFilter ? ' active' : '') + '" data-action="timeline-filter" data-type-filter="">全部 (' + obs.length + ')</span>';
      typeList.forEach(function(t) {
        var color = OBS_TYPE_COLORS[t] || '#666666';
        html += '<span class="type-chip' + (tlTypeFilter === t ? ' active' : '') + '" data-action="timeline-filter" data-type-filter="' + esc(t) + '" style="' + (tlTypeFilter === t ? 'background:' + color + ';border-color:' + color + ';' : 'border-color:' + color + ';color:' + color + ';') + '">' + esc(t.replace(/_/g, ' ')) + ' (' + typeCounts[t] + ')</span>';
      });
      html += '</div>';

      if (paged.length === 0) {
        html += '<div class="empty-state"><div class="empty-icon">&#128337;</div><p>暂无观察记录' + (obs.length > 0 ? '（当前筛选无结果，共 ' + obs.length + ' 条）' : '（该会话下）') + '</p></div>';
        content.innerHTML = html;
        return;
      }

      html += '<div style="font-size:11px;color:var(--ink-faint);margin-bottom:16px;font-family:var(--font-ui);letter-spacing:0.03em;">当前文件夹共显示 ' + filtered.length + ' 条记录</div>';

      html += '<div class="timeline-container">';

      var lastDateGroup = '';
      paged.forEach(function(o, idx) {
        var isCompressed = !!o.narrative || !!o.type;
        var isRaw = !isCompressed;
	        var type = observationType(o);
        var isFocusEvent = type === 'decision' || type === 'error' || type === 'task' || type === 'conversation';
        var impClass = isFocusEvent ? 'high' : 'low';
        var display = observationDisplay(o);
        var title = display.title;
        var typeColor = OBS_TYPE_COLORS[type] || '#666666';
        var icon = OBS_TYPE_ICONS[type] || '&#128196;';

        var dateGroup = '';
        try {
          var d = new Date(o.timestamp);
          dateGroup = d.toLocaleDateString() + ' ' + d.getHours() + ':00';
        } catch(e) { dateGroup = ''; }

        if (dateGroup && dateGroup !== lastDateGroup) {
          html += '<div class="timeline-date-marker"><span>' + esc(dateGroup) + '</span></div>';
          lastDateGroup = dateGroup;
        }

        var side = idx % 2 === 0 ? 'tl-left' : 'tl-right';

        html += '<div class="timeline-item ' + side + '">';
        html += '<div class="timeline-dot" style="background:' + typeColor + ';"></div>';
        html += '<div class="timeline-connector"></div>';

        html += '<div class="obs-card imp-' + impClass + '" style="border-left-color:' + typeColor + ';text-align:left;">';
        html += '<div class="obs-head">';
        html += '<div class="obs-title-row">';
        html += '<span class="obs-type-icon">' + icon + '</span>';
        html += '<span class="obs-title" title="' + esc(title) + '">' + esc(title) + '</span>';
        if (isRaw) html += '<span class="badge badge-muted" style="font-size:8px;margin-left:4px;">raw</span>';
        html += '</div>';
        html += '<div class="obs-meta">';
        html += '<span class="obs-time">' + esc(shortTime(o.timestamp)) + '</span>';
        html += '</div></div>';

        if (display.subtitle) html += '<div class="obs-subtitle">' + esc(display.subtitle) + '</div>';

        html += '<div style="margin-top:4px;">';
        html += '<span class="badge" style="border-color:' + typeColor + ';color:' + typeColor + ';margin-right:4px;">' + esc(type.replace(/_/g, ' ')) + '</span>';
        if (o.hookType) html += '<span class="badge badge-muted" style="margin-right:4px;">' + esc(o.hookType) + '</span>';
        html += '</div>';

        if (isRaw && o.toolInput) {
          var inputStr = typeof o.toolInput === 'string' ? o.toolInput : JSON.stringify(o.toolInput);
          html += '<div style="margin-top:6px;"><span style="font-size:10px;color:var(--ink-muted);font-weight:600;font-family:var(--font-ui);text-transform:uppercase;letter-spacing:0.08em;">输入：</span>';
          html += '<pre style="font-size:11px;color:var(--ink-muted);background:var(--bg-alt);padding:8px 10px;border:1px solid var(--border-light);margin-top:3px;overflow-x:auto;max-height:80px;font-family:var(--font-mono);">' + esc(truncate(inputStr, 300)) + '</pre></div>';
        }
        if (isRaw && o.toolOutput) {
          var outputStr = typeof o.toolOutput === 'string' ? o.toolOutput : JSON.stringify(o.toolOutput);
          html += '<div style="margin-top:4px;"><span style="font-size:10px;color:var(--ink-muted);font-weight:600;font-family:var(--font-ui);text-transform:uppercase;letter-spacing:0.08em;">输出：</span>';
          html += '<div class="obs-narrative" style="margin-top:3px;">' + esc(truncate(outputStr, 300)) + '</div></div>';
        }
        if (display.body) html += '<div class="obs-narrative" style="margin-top:8px;">' + esc(display.body) + '</div>';
        if (o.facts && o.facts.length > 0) {
          html += '<ul class="obs-facts">';
          o.facts.forEach(function(f) { html += '<li>' + esc(f) + '</li>'; });
          html += '</ul>';
        }

        var hasTags = (o.concepts && o.concepts.length) || (o.files && o.files.length);
        if (hasTags) {
          html += '<div class="tag-list">';
          (o.concepts || []).forEach(function(c) { html += '<span class="tag">' + esc(c) + '</span>'; });
          (o.files || []).forEach(function(f) {
            var short = f.split('/').pop();
            html += '<span class="tag file-tag" title="' + esc(f) + '">' + esc(short) + '</span>';
          });
          html += '</div>';
        }
        if (isRaw && o.toolInput) {
          var files = [];
          var ti = o.toolInput;
          if (typeof ti === 'object' && ti !== null) {
            if (ti.file_path) files.push(ti.file_path);
            if (ti.path) files.push(ti.path);
          }
          if (files.length > 0) {
            html += '<div class="tag-list">';
            files.forEach(function(f) {
              var short = String(f).split('/').pop();
              html += '<span class="tag file-tag" title="' + esc(f) + '">' + esc(short) + '</span>';
            });
            html += '</div>';
          }
        }
        html += '</div>';
        html += '</div>';
      });

      html += '</div>';

      if (totalPages > 1) {
        html += '<div class="pagination">';
        if (page > 0) html += '<button class="btn" data-action="timeline-page" data-page="' + (page - 1) + '">上一页</button>';
        html += '<span style="color:var(--ink-faint);font-size:12px;padding:6px;font-family:var(--font-mono);">第 ' + (page + 1) + ' / ' + totalPages + ' 页（共 ' + filtered.length + ' 条）</span>';
        if (page < totalPages - 1) html += '<button class="btn" data-action="timeline-page" data-page="' + (page + 1) + '">下一页</button>';
        html += '</div>';
      }

      content.innerHTML = html;
    }

    function setTlTypeFilter(type) {
      tlTypeFilter = type;
      state.timeline.page = 0;
      renderObservations();
    }

    function tlPage(p) {
      state.timeline.page = p;
      renderObservations();
    }

    async function loadActivity() {
      var el = document.getElementById('view-activity');
      state.activity.loadingPhase = '正在读取本地会话';
      el.innerHTML = '<div class="loading">加载活动中...</div>';
      state.activity.warnings = [];
      var results = await Promise.all([
        settledData('工作台会话', { sessions: [] }, function() { return apiGet('sessions'); }),
        settledData('审计记录', { entries: [] }, function() { return apiGet('audit?limit=80'); }),
        settledData('本地会话', [], function() { return loadLocalCodexSessions(60); })
      ]);
      state.activity.warnings = results.filter(function(r) { return r.failed; }).map(function(r) { return r.label; });
      var sessions = mergeSessions(((results[0].data && results[0].data.sessions) || []), results[2].data || []).filter(function(s) { return !isDemoSession(s); });
      var auditEntries = (results[1].data && results[1].data.entries) || [];

      var allObs = [];
      var sorted = sessions.slice().sort(function(a, b) { return (b.startedAt || '').localeCompare(a.startedAt || ''); });
      var localObs = sorted.filter(function(s) {
        return String(s.source || '') === 'local-codex-jsonl';
      }).map(function(s) {
        return {
          id: sessionId(s),
          sessionId: sessionId(s),
          timestamp: sessionRecordTime(s),
          type: 'conversation',
          title: sessionTitleText(s) || 'Codex 会话',
          narrative: sessionBodyPreview(s, sessionTitleText(s)),
          project: s.project,
          cwd: s.cwd,
          agentId: 'Codex'
        };
      }).filter(function(o) {
        var t = String(o.title || '');
        return t && t !== 'Codex Desktop' && t.indexOf('Automation:') !== 0;
      });
      allObs = allObs.concat(localObs);

      var recentSessions = sorted.filter(function(s) {
        return String(s.source || '') !== 'local-codex-jsonl';
      }).slice(0, 5);

      state.activity.sessions = sessions;
      state.activity.observations = allObs;
      state.activity.audit = auditEntries;
      state.activity.loaded = true;
      state.activity.loadingPhase = recentSessions.length ? '正在补齐最近会话细节' : '';
      renderActivity();

      var obsResults = await Promise.all(recentSessions.filter(function(s) { return sessionId(s); }).map(function(s) {
        return settledData('会话细节', null, function() { return apiGet('observations?sessionId=' + encodeURIComponent(sessionId(s))); });
      }));
      obsResults.forEach(function(r) {
        if (r && r.failed && state.activity.warnings.indexOf(r.label) < 0) state.activity.warnings.push(r.label);
        if (r && r.data && r.data.observations) allObs = allObs.concat(r.data.observations);
      });
      state.activity.observations = allObs;
      state.activity.loadingPhase = '';
      renderActivity();
    }

    function renderActivity() {
      var el = document.getElementById('view-activity');
      var obs = state.activity.observations;
      var sessions = state.activity.sessions;

      var TOOL_TYPE_MAP = { Read: 'file_read', Write: 'file_write', Edit: 'file_edit', Bash: 'command_run', Grep: 'search', Glob: 'search', WebFetch: 'web_fetch', WebSearch: 'web_fetch', AskUserQuestion: 'conversation', Task: 'subagent' };

      var html = '';

      html += renderDataWarnings(state.activity.warnings, 'refresh-activity');

      if (state.activity.loadingPhase) {
        html += '<div class="activity-status-card"><div class="activity-status-main"><span class="activity-status-dot"></span><span>' + esc(state.activity.loadingPhase) + '</span></div><div class="activity-status-meta">' + obs.length + ' 条</div></div>';
      }

      html += '<div class="card"><div class="card-title">活动热力图（近一年）</div>';
      var dayCounts = {};
      obs.forEach(function(o) {
        try {
          var d = new Date(o.timestamp);
          var key = d.toISOString().slice(0, 10);
          dayCounts[key] = (dayCounts[key] || 0) + 1;
        } catch(e) {}
      });
      sessions.forEach(function(s) {
        try {
          var d = new Date(s.startedAt);
          var key = d.toISOString().slice(0, 10);
          dayCounts[key] = (dayCounts[key] || 0) + 1;
        } catch(e) {}
      });

      var maxCount = 0;
      Object.keys(dayCounts).forEach(function(k) { if (dayCounts[k] > maxCount) maxCount = dayCounts[k]; });

      var today = new Date();
      var dayLabels = ['一', '', '三', '', '五', '', ''];
      html += '<div class="heatmap-labels">';
      dayLabels.forEach(function(l) { html += '<span style="width:10px;text-align:center;">' + l + '</span>'; });
      html += '</div>';
      html += '<div class="heatmap-wrap"><div class="heatmap-grid">';
      for (var w = 51; w >= 0; w--) {
        for (var d = 0; d < 7; d++) {
          var cellDate = new Date(today);
          cellDate.setDate(cellDate.getDate() - (w * 7 + (6 - d)));
          var key = cellDate.toISOString().slice(0, 10);
          var count = dayCounts[key] || 0;
          var level = count === 0 ? '' : count <= (maxCount * 0.25) ? 'level-1' : count <= (maxCount * 0.5) ? 'level-2' : count <= (maxCount * 0.75) ? 'level-3' : 'level-4';
          var title = key + '：' + count + ' 条活动';
          html += '<div class="heatmap-cell ' + level + '" title="' + esc(title) + '"></div>';
        }
      }
      html += '</div></div>';
      html += '<div style="display:flex;align-items:center;gap:4px;margin-top:8px;font-size:10px;color:var(--ink-faint);font-family:var(--font-mono);justify-content:flex-end;">较少 ';
      html += '<div class="heatmap-cell" style="display:inline-block;"></div>';
      html += '<div class="heatmap-cell level-1" style="display:inline-block;"></div>';
      html += '<div class="heatmap-cell level-2" style="display:inline-block;"></div>';
      html += '<div class="heatmap-cell level-3" style="display:inline-block;"></div>';
      html += '<div class="heatmap-cell level-4" style="display:inline-block;"></div>';
      html += ' 较多</div>';
      html += '</div>';

      var typeCounts = {};
      obs.forEach(function(o) {
        var t = o.type || TOOL_TYPE_MAP[o.toolName] || (o.hookType ? o.hookType.replace(/_/g, ' ') : 'other');
        typeCounts[t] = (typeCounts[t] || 0) + 1;
      });
      var typeList = Object.keys(typeCounts).sort(function(a, b) { return typeCounts[b] - typeCounts[a]; });
      var totalObs = obs.length || 1;

      html += '<div class="two-col" style="margin-top:16px;">';

      html += '<div class="card"><div class="card-title">类型分布</div>';
      if (typeList.length === 0) {
        html += '<div style="font-size:13px;color:var(--ink-faint);font-style:italic;">还没有观察记录</div>';
      } else {
        html += '<div class="bar-chart">';
        typeList.slice(0, 12).forEach(function(t) {
          var pct = Math.round((typeCounts[t] / totalObs) * 100);
          var color = OBS_TYPE_COLORS[t] || '#666666';
          html += '<div class="bar-row"><span class="bar-label">' + esc(observationTypeLabel(t)) + '</span><div class="bar-track"><div class="bar-fill" style="width:' + pct + '%;background:' + color + ';"></div></div><span class="bar-value">' + typeCounts[t] + '</span></div>';
        });
        html += '</div>';
      }
      html += '</div>';

      html += '<div class="card"><div class="card-title">活动流</div>';
      var sortedObs = obs.slice().sort(function(a, b) { return (b.timestamp || '').localeCompare(a.timestamp || ''); });
      if (sortedObs.length === 0) {
        html += '<div style="font-size:13px;color:var(--ink-faint);font-style:italic;">暂无最近活动</div>';
      } else {
        sortedObs.slice(0, 20).forEach(function(o) {
          var type = o.type || TOOL_TYPE_MAP[o.toolName] || 'other';
          var typeColor = OBS_TYPE_COLORS[type] || '#666666';
          var icon = OBS_TYPE_ICONS[type] || '&#128196;';
          var display = observationDisplay(o);
          var title = display.title;

          var sess = sessions.find(function(s) { return sessionId(s) && (sessionId(s) === o.sessionId || sessionId(s) === o.session_id); });
          var source = inferSessionSource(sess || { project: o.project || '', cwd: o.cwd || '' });
          var avatar = agentAvatarSpec(source.name);
          html += '<div class="activity-feed-item">';
          html += renderAgentAvatar(avatar);
          html += '<div class="activity-feed-body">';
          html += '<div class="activity-feed-title">' + esc(truncate(title, 60)) + '</div>';
          if (display.body) html += '<div style="font-size:12px;color:var(--ink-muted);margin-top:2px;">' + esc(truncate(display.body, 120)) + '</div>';
          html += '<div class="activity-feed-meta">' + esc(source.name) + ' · ' + esc(observationTypeLabel(type));
          if (o.files && o.files.length) html += ' &middot; <span class="tag file-tag" style="font-size:9px;padding:0 4px;">' + esc(o.files[0].split('/').pop()) + '</span>';
          html += ' &middot; ' + esc(shortTime(o.timestamp)) + '</div>';
          html += '</div></div>';
        });
      }
      html += '</div>';

      html += '</div>';

      el.innerHTML = html;
    }

