;(function(window, document, undefined) {
  'use strict';

  var StyleManager = (function(){
    return {
      testHost: function(){
        setTimeout(function(){
          StyleManager.injectStyle();
        },100);
      },
      injectStyle: function(config){
        var $head = document.head || document.querySelector('head');
        if(!$head){
          // When running at document_start the <head> may not exist yet.
          setTimeout(function(){
            StyleManager.injectStyle(config);
          },50);
          return;
        }

        var $existing = $head.querySelector('style[data-type=inject]');
        if($existing){
          $existing.parentElement.removeChild($existing);
        }
    
        var $inject = document.createElement('style');
        $inject.setAttribute('type','text/css');
        $inject.setAttribute('data-type','inject');
    
        var widgetStyle = "<!-- tid:compiledstyle -->";
        $inject.innerHTML = widgetStyle;
        
        $head.appendChild($inject);
      },
    };
  })();

  StyleManager.testHost();

  // Add keyboard seeking that doesn't trigger the site's own controls overlay.
  // This is intentionally lightweight and site-agnostic: it targets the primary <video>.
  var KeyboardSeek = (function(){
    var SEEK_SECONDS = 10;
    var SEEK_SECONDS_BIG = 30;

    var _scrimSeen = (typeof WeakSet !== 'undefined') ? new WeakSet() : null;
    var _scrimStyleInjected = false;
    var SCRIM_ATTR = 'data-vuic-scrim';
    var _scrimRaf = 0;

    function isPrimeLikeHost(){
      var host = (window.location && window.location.hostname) ? window.location.hostname : '';
      return host.indexOf('primevideo.com') !== -1 || host.indexOf('amazon.') !== -1;
    }

    function hasPrimePlayerDom(){
      return !!document.querySelector('.atvwebplayersdk-player-container,.atvwebplayersdk-overlays-container,.cascadesContainer .webPlayer');
    }

    function isVideoLargeEnough(video){
      if(!video || !video.getBoundingClientRect){
        return false;
      }

      var r = video.getBoundingClientRect();
      var videoArea = r.width * r.height;
      var viewportArea = window.innerWidth * window.innerHeight;

      if(viewportArea <= 0){
        return true;
      }

      return (videoArea / viewportArea) >= 0.2;
    }

    function isLikelyPlayerPage(video){
      if(document.fullscreenElement && document.fullscreenElement.contains && document.fullscreenElement.contains(video)){
        return true;
      }

      if(isPrimeLikeHost()){
        return hasPrimePlayerDom();
      }

      return isVideoLargeEnough(video);
    }

    function isEditableTarget(el){
      if(!el){
        return false;
      }

      if(el.isContentEditable){
        return true;
      }

      var tag = el.tagName;
      if(!tag){
        return false;
      }

      tag = tag.toUpperCase();
      return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
    }

    function clamp(n, min, max){
      return Math.min(Math.max(n, min), max);
    }

    function scoreVideo(v, rect, doc){
      if(!rect || rect.width <= 0 || rect.height <= 0){
        return -1;
      }

      var area = rect.width * rect.height;
      var score = area;
      if(!v.paused){
        score = score * 2;
      }
      if(doc && doc.fullscreenElement && doc.fullscreenElement.contains && doc.fullscreenElement.contains(v)){
        score = score * 3;
      }
      return score;
    }

    function getPrimaryVideo(){
      var best = null;
      var bestScore = -1;

      function scanDocument(doc, offsetX, offsetY, depth){
        if(!doc || depth <= 0){
          return;
        }

        var videos;
        try{
          videos = doc.querySelectorAll('video');
        }catch(e){
          videos = null;
        }

        if(videos && videos.length){
          for(var i = 0; i < videos.length; i++){
            var v = videos[i];
            if(!v || !v.getBoundingClientRect){
              continue;
            }

            var r = v.getBoundingClientRect();
            // Normalize into the top document's viewport coordinate space.
            var rect = {
              left: r.left + offsetX,
              top: r.top + offsetY,
              right: r.right + offsetX,
              bottom: r.bottom + offsetY,
              width: r.width,
              height: r.height
            };

            var s = scoreVideo(v, rect, doc);
            if(s > bestScore){
              best = v;
              bestScore = s;
            }
          }
        }

        var iframes;
        try{
          iframes = doc.querySelectorAll('iframe');
        }catch(e2){
          iframes = null;
        }

        if(iframes && iframes.length){
          for(var j = 0; j < iframes.length; j++){
            var fr = iframes[j];
            if(!fr || !fr.getBoundingClientRect){
              continue;
            }

            var frRect = fr.getBoundingClientRect();

            var childDoc = null;
            try{
              childDoc = fr.contentDocument;
            }catch(e3){
              childDoc = null;
            }

            if(!childDoc){
              continue;
            }

            scanDocument(childDoc, offsetX + frRect.left, offsetY + frRect.top, depth - 1);
          }
        }
      }

      scanDocument(document, 0, 0, 3);
      return best;
    }

    function seekBy(video, deltaSeconds){
      if(!video){
        return false;
      }

      try{
        var cur = video.currentTime;
        var next = cur + deltaSeconds;

        // Some players expose duration as NaN until metadata loads.
        var dur = video.duration;
        if(typeof dur === 'number' && isFinite(dur)){
          next = clamp(next, 0, Math.max(dur - 0.01, 0));
        }else{
          next = Math.max(next, 0);
        }

        video.currentTime = next;
        return true;
      }catch(e){
        return false;
      }
    }

    function alphaFromCssColor(color){
      if(!color || color === 'transparent'){
        return 0;
      }

      var m = String(color).match(/rgba?\\(([^)]+)\\)/i);
      if(!m){
        return 0;
      }

      var inner = m[1];
      // Support both comma-separated and space-separated syntax, including "rgb(r g b / a)".
      if(inner.indexOf('/') !== -1){
        var partsSlash = inner.split('/');
        if(partsSlash.length >= 2){
          var a = parseFloat(partsSlash[1]);
          return isNaN(a) ? 1 : a;
        }
      }

      var parts = inner.indexOf(',') !== -1 ? inner.split(',') : inner.trim().split(/\\s+/);
      if(parts.length < 4){
        return 1;
      }

      var alpha = parseFloat(parts[3]);
      return isNaN(alpha) ? 1 : alpha;
    }

    function neutralizeScrimElement(el){
      if(!el || !el.style){
        return;
      }

      if(!_scrimStyleInjected){
        _scrimStyleInjected = true;

        var $head = document.head || document.documentElement;
        if($head){
          var $style = document.createElement('style');
          $style.setAttribute('type','text/css');
          $style.setAttribute('data-type','vuic-scrim-override');
          $style.textContent = "["+SCRIM_ATTR+"=\"1\"]{background:transparent !important;background-color:transparent !important;background-image:none !important;backdrop-filter:none !important;-webkit-backdrop-filter:none !important}["+SCRIM_ATTR+"=\"1\"]::before,["+SCRIM_ATTR+"=\"1\"]::after{background:transparent !important;background-color:transparent !important;background-image:none !important;opacity:0 !important;backdrop-filter:none !important;-webkit-backdrop-filter:none !important;box-shadow:none !important}";
          $head.appendChild($style);
        }
      }

      if(_scrimSeen){
        if(_scrimSeen.has(el)){
          return;
        }
        _scrimSeen.add(el);
      }

      try{
        el.setAttribute(SCRIM_ATTR,'1');
      }catch(e0){}

      el.style.setProperty('background', 'transparent', 'important');
      el.style.setProperty('background-color', 'transparent', 'important');
      el.style.setProperty('background-image', 'none', 'important');
      el.style.setProperty('backdrop-filter', 'none', 'important');
      el.style.setProperty('-webkit-backdrop-filter', 'none', 'important');
    }

    function elementHasScrimBackground(el){
      if(!el || !window.getComputedStyle){
        return false;
      }

      var style = window.getComputedStyle(el);
      if(!style){
        return false;
      }

      if(style.display === 'none' || style.visibility === 'hidden'){
        return false;
      }

      var bgAlpha = alphaFromCssColor(style.backgroundColor);
      var bgImage = style.backgroundImage || '';
      if(bgAlpha > 0 || (bgImage && bgImage !== 'none')){
        return true;
      }

      // Some players render the dim overlay with a pseudo-element.
      var before = window.getComputedStyle(el,'::before');
      if(before && before.content && before.content !== 'none'){
        var a1 = alphaFromCssColor(before.backgroundColor);
        var i1 = before.backgroundImage || '';
        if(a1 > 0 || (i1 && i1 !== 'none')){
          return true;
        }
      }

      var after = window.getComputedStyle(el,'::after');
      if(after && after.content && after.content !== 'none'){
        var a2 = alphaFromCssColor(after.backgroundColor);
        var i2 = after.backgroundImage || '';
        if(a2 > 0 || (i2 && i2 !== 'none')){
          return true;
        }
      }

      return false;
    }

    // Best-effort: if a player shows a fullscreen scrim on seek, make it transparent.
    function neutralizeScrimOverVideo(video){
      if(!video || !video.getBoundingClientRect || !document.elementsFromPoint){
        return;
      }

      var vr = video.getBoundingClientRect();
      if(vr.width <= 0 || vr.height <= 0){
        return;
      }

      var x = vr.left + (vr.width / 2);
      var y = vr.top + (vr.height / 2);
      if(x < 0 || y < 0 || x > window.innerWidth || y > window.innerHeight){
        return;
      }

      var stack = [];

      function pushFromPoint(px, py){
        var els = document.elementsFromPoint(px, py);
        if(!els){
          return;
        }
        for(var i = 0; i < els.length; i++){
          stack.push(els[i]);
        }
      }

      // Sample a few points, since overlays sometimes don't cover the center.
      pushFromPoint(x, y);
      pushFromPoint(vr.left + 10, vr.top + 10);
      pushFromPoint(vr.right - 10, vr.top + 10);
      pushFromPoint(vr.left + 10, vr.bottom - 10);
      pushFromPoint(vr.right - 10, vr.bottom - 10);

      if(stack.length === 0){
        return;
      }

      var seen = (typeof WeakSet !== 'undefined') ? new WeakSet() : null;
      var videoArea = vr.width * vr.height;

      for(var k = 0; k < stack.length; k++){
        var el = stack[k];
        if(!el || el === video){
          continue;
        }
        if(seen){
          if(seen.has(el)){
            continue;
          }
          seen.add(el);
        }
        if(!el.getBoundingClientRect){
          continue;
        }

        if(!elementHasScrimBackground(el)){
          continue;
        }

        var er = el.getBoundingClientRect();
        var overlapW = Math.max(0, Math.min(vr.right, er.right) - Math.max(vr.left, er.left));
        var overlapH = Math.max(0, Math.min(vr.bottom, er.bottom) - Math.max(vr.top, er.top));
        var overlapArea = overlapW * overlapH;
        if(videoArea <= 0){
          continue;
        }

        if((overlapArea / videoArea) < 0.25){
          continue;
        }

        neutralizeScrimElement(el);
        // Don't return immediately; there can be multiple overlapping scrims.
      }
    }

    function scheduleScrimNeutralize(maybeVideo){
      if(_scrimRaf){
        return;
      }

      _scrimRaf = window.requestAnimationFrame(function(){
        _scrimRaf = 0;

        var v = (maybeVideo && maybeVideo.nodeName === 'VIDEO') ? maybeVideo : null;
        if(!v){
          v = getPrimaryVideo();
        }
        if(!v){
          return;
        }

        if(!isLikelyPlayerPage(v)){
          return;
        }

        neutralizeScrimOverVideo(v);
      });
    }

    function normalizeKey(e){
      if(e && e.key){
        return e.key;
      }
      if(e && typeof e.keyCode === 'number'){
        // Basic fallback for older keyCode-based events.
        if(e.keyCode === 37) return 'ArrowLeft';
        if(e.keyCode === 39) return 'ArrowRight';
      }
      return '';
    }

    function getSeekDeltaForEvent(e){
      if(!e){
        return null;
      }
      if(e.metaKey || e.ctrlKey || e.altKey){
        return null;
      }

      if(e.isComposing){
        return null;
      }

      if(isEditableTarget(e.target)){
        return null;
      }

      var key = normalizeKey(e);
      if(key === 'ArrowRight'){
        return e.shiftKey ? SEEK_SECONDS_BIG : SEEK_SECONDS;
      }else if(key === 'ArrowLeft'){
        return -(e.shiftKey ? SEEK_SECONDS_BIG : SEEK_SECONDS);
      }else if(key === 'l' || key === 'L'){
        return SEEK_SECONDS;
      }else if(key === 'j' || key === 'J'){
        return -SEEK_SECONDS;
      }

      return null;
    }

    function blockEvent(e){
      e.preventDefault();
      if(e.stopImmediatePropagation){
        e.stopImmediatePropagation();
      }
      if(e.stopPropagation){
        e.stopPropagation();
      }
    }

    function onKeyDown(e){
      var delta = getSeekDeltaForEvent(e);
      if(delta === null){
        return;
      }

      var video = getPrimaryVideo();
      if(!video){
        return;
      }

      // Avoid hijacking arrow keys on non-player pages (ex: amazon.com product pages).
      if(!isLikelyPlayerPage(video)){
        return;
      }

      // Block the site's handler (which often shows the dimming overlay).
      blockEvent(e);

      seekBy(video, delta);

      // If the player still shows a scrim on seek, make it transparent.
      scheduleScrimNeutralize(video);
      setTimeout(function(){
        scheduleScrimNeutralize(video);
      },50);
    }

    function onKeyUp(e){
      // Some players show the overlay on keyup; block it if we handle the key.
      var delta = getSeekDeltaForEvent(e);
      if(delta === null){
        return;
      }

      var video = getPrimaryVideo();
      if(!video){
        return;
      }

      if(!isLikelyPlayerPage(video)){
        return;
      }

      blockEvent(e);
      scheduleScrimNeutralize(video);
    }

    function bind(){
      // Capture phase + document_start helps us run before the site registers its listeners.
      window.addEventListener('keydown', onKeyDown, true);
      window.addEventListener('keyup', onKeyUp, true);

      // Remove the dimmer overlay when controls appear (hover/move usually triggers it).
      window.addEventListener('mousemove', scheduleScrimNeutralize, true);
      window.addEventListener('pointermove', scheduleScrimNeutralize, true);
      window.addEventListener('mouseover', scheduleScrimNeutralize, true);
      window.addEventListener('focus', scheduleScrimNeutralize, true);
      document.addEventListener('fullscreenchange', scheduleScrimNeutralize, true);

      if(typeof MutationObserver !== 'undefined'){
        try{
          var root = document.documentElement;
          if(root){
            var obs = new MutationObserver(function(mutations){
              for(var i = 0; i < mutations.length; i++){
                var m = mutations[i];
                if(m.type === 'attributes'){
                  if(m.attributeName === SCRIM_ATTR){
                    continue;
                  }
                  var t = m.target;
                  if(t && t.getAttribute && t.getAttribute(SCRIM_ATTR) === '1'){
                    continue;
                  }
                }
                scheduleScrimNeutralize();
                break;
              }
            });

            obs.observe(root,{
              childList: true,
              subtree: true,
              attributes: true,
              attributeFilter: ['class','style',SCRIM_ATTR]
            });
          }
        }catch(e){}
      }

      // Kick once after initial layout.
      setTimeout(function(){
        scheduleScrimNeutralize();
      },250);
    }

    return {
      bind: bind
    };
  })();

  KeyboardSeek.bind();

  var Deferred = function(){
    var def = this;
    this.promise = new Promise(function(resolve,reject){
      def.resolve = resolve;
      def.reject = reject;
    });

    this.then = this.promise.then.bind(this.promise);
    this.catch = this.promise.catch.bind(this.promise);
  };
})(window, document);
