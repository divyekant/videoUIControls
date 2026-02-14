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

    function getPrimaryVideo(){
      var videos = document.querySelectorAll('video');
      if(!videos || videos.length === 0){
        return null;
      }

      var best = null;
      var bestScore = -1;

      for(var i = 0; i < videos.length; i++){
        var v = videos[i];
        if(!v || !v.getBoundingClientRect){
          continue;
        }

        var rect = v.getBoundingClientRect();
        if(rect.width <= 0 || rect.height <= 0){
          continue;
        }

        var area = rect.width * rect.height;
        var score = area;
        if(!v.paused){
          score = score * 2;
        }
        if(document.fullscreenElement && document.fullscreenElement.contains && document.fullscreenElement.contains(v)){
          score = score * 3;
        }

        if(score > bestScore){
          best = v;
          bestScore = score;
        }
      }

      return best || videos[0] || null;
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

      if(_scrimSeen){
        if(_scrimSeen.has(el)){
          return;
        }
        _scrimSeen.add(el);
      }

      el.style.setProperty('background', 'transparent', 'important');
      el.style.setProperty('background-color', 'transparent', 'important');
      el.style.setProperty('background-image', 'none', 'important');
      el.style.setProperty('backdrop-filter', 'none', 'important');
      el.style.setProperty('-webkit-backdrop-filter', 'none', 'important');
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

      var stack = document.elementsFromPoint(x, y);
      if(!stack || stack.length === 0){
        return;
      }

      var videoArea = vr.width * vr.height;
      for(var i = 0; i < stack.length; i++){
        var el = stack[i];
        if(!el || el === video){
          continue;
        }
        if(video.contains && video.contains(el)){
          continue;
        }
        if(!el.getBoundingClientRect){
          continue;
        }

        var style = window.getComputedStyle ? window.getComputedStyle(el) : null;
        if(!style){
          continue;
        }

        if(style.display === 'none' || style.visibility === 'hidden'){
          continue;
        }

        var bgAlpha = alphaFromCssColor(style.backgroundColor);
        var bgImage = style.backgroundImage || '';
        var hasBg = bgAlpha > 0 || (bgImage && bgImage !== 'none');
        if(!hasBg){
          continue;
        }

        var er = el.getBoundingClientRect();
        var overlapW = Math.max(0, Math.min(vr.right, er.right) - Math.max(vr.left, er.left));
        var overlapH = Math.max(0, Math.min(vr.bottom, er.bottom) - Math.max(vr.top, er.top));
        var overlapArea = overlapW * overlapH;
        if(videoArea <= 0){
          continue;
        }

        // Only touch elements that cover a substantial portion of the video.
        if((overlapArea / videoArea) < 0.4){
          continue;
        }

        neutralizeScrimElement(el);
        return;
      }
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

    function onKeyDown(e){
      if(!e){
        return;
      }

      if(e.metaKey || e.ctrlKey || e.altKey){
        return;
      }

      if(e.isComposing){
        return;
      }

      if(isEditableTarget(e.target)){
        return;
      }

      var key = normalizeKey(e);
      var delta = null;

      if(key === 'ArrowRight'){
        delta = e.shiftKey ? SEEK_SECONDS_BIG : SEEK_SECONDS;
      }else if(key === 'ArrowLeft'){
        delta = -(e.shiftKey ? SEEK_SECONDS_BIG : SEEK_SECONDS);
      }else if(key === 'l' || key === 'L'){
        delta = SEEK_SECONDS;
      }else if(key === 'j' || key === 'J'){
        delta = -SEEK_SECONDS;
      }else{
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
      e.preventDefault();
      if(e.stopImmediatePropagation){
        e.stopImmediatePropagation();
      }
      if(e.stopPropagation){
        e.stopPropagation();
      }

      seekBy(video, delta);

      // If the player still shows a scrim on seek, make it transparent.
      setTimeout(function(){
        neutralizeScrimOverVideo(video);
      },0);
    }

    function bind(){
      // Capture phase + document_start helps us run before the site registers its listeners.
      window.addEventListener('keydown', onKeyDown, true);
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
