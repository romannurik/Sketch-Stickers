/*
 * Copyright 2018 Google Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

// trigger copying of related assets
require('file-loader?name=[name].[ext]!./index.html');

// libraries
import * as $ from 'jquery';
import Vue from 'vue';

import ElementVisibility from './lib/element-visibility';
import StickersClient from './client';


// load icons
const requireAll = r => r.keys().map(r);
requireAll(require.context('!svg-sprite-loader!./icons/', false, /.*\.svg$/))
    .map(m => m.default)
    .reduce((acc, icon) => ({
      ...acc,
      [icon.id]: icon
    }), {});


// consts
const MAX_DRAW_WIDTH = 300;
const MAX_DRAW_HEIGHT = 400;


// page controller
class StickersPage {
  constructor() {
    this.setupCoreUi();
    this.setupStickersUi();
    StickersClient.init();
    StickersClient.on('load-progress', f => this.vue.indexLoadProgress = f);
    StickersClient.once('loaded', stickerIndex => {
      this.processStickerIndex(stickerIndex);
      this.vue.stickerIndex = stickerIndex;
      this.vue.$nextTick(() => {
        $('.header-area__search-field').focus();
        this.loadVisibleStickers();
      });
    });
  }

  processStickerIndex(stickerIndex) {
    stickerIndex.libraries = stickerIndex.libraries
        .filter(lib => !!lib.sections.length);

    for (let library of stickerIndex.libraries) {
      for (let section of library.sections) {
        section.rows = [];
        let currentRow = null;

        let newRow = () => {
          currentRow = {items: []};
          section.rows.push(currentRow);
        };

        for (let item of section.items) {
          if (item.layout == 'row') {
            newRow();
            currentRow.items.push(item);
            newRow();
          } else {
            if (!currentRow) {
              newRow();
            }
            currentRow.items.push(item);
          }
        }
      }
    }
  }

  setupCoreUi() {
    $(document.body).attr('ui-mode',
        (window.location.search.match(/uiMode=(\w+)/) || [])[1] || 'cover');

    if (window.location.search.match(/darkMode=1/)) {
      $(document.body).attr('is-dark-theme', '1');
    }

    $(document).on('contextmenu', e => e.preventDefault());
    $(document).on('click', 'a[href]', ev => {
      let url = $(ev.target).attr('href');
      StickersClient.openUrl(url);
      ev.preventDefault();
    });

    var me = this;

    this.vueGlobal = new Vue({
      data: {
        searchText: ''
      },
    });

    Vue.prototype.$globals = this.vueGlobal;

    Vue.component('hilitext', {
      template: `<div v-html="highlight(text, $globals.searchText)"></div>`,
      props: ['text'],
      methods: {
        highlight: (text, query) => {
          if (!query) {
            return text;
          }

          return String(text || '').replace(
              new RegExp(query, 'ig'),
              matchedText => `<span class="search-highlight">${matchedText}</span>`);
        }
      }
    });

    Vue.component('svg-icon', {
      template: `<svg class="svg-icon"><use :xlink:href="'#' + glyph" /></svg>`,
      props: ['glyph'],
    });

    Vue.component('sticker', {
      props: ['sticker', 'parentSection'],
      template: '#sticker-template',
      computed: {
        drawSize() {
          return me.calcDrawSize(this.sticker);
        }
      },
    });

    this.vue = new Vue({
      el: '.root',
      data: {
        indexLoadProgress: 0,
        stickerIndex: null,
      },
      methods: {
        addLibraryColors(library) {
          StickersClient.addLibraryColors(library.id);
          library.colorsAdded = true;
        },
        closeWindow() {
          StickersClient.close();
        },
        onSearchKeydown(ev) {
          if (ev.keyCode == 27) {
            if (ev.target.value) {
              ev.preventDefault();
              ev.target.value = '';
              me.updateSearch();
            }
          }
        },
        onSearchInput(ev) {
          $(window).scrollTop(0);
          me.updateSearch();
        },
      },
    });
  }

  updateSearch() {
    // TODO: move this to a watcher in vueGlobal
    this.vue.$nextTick(() => {
      $(document.body).toggleClass('has-active-search', !!this.vueGlobal.searchText);
      ['.sticker-root-section', '.sticker-sub-section', '.sticker'].forEach(level => {
        let $allAtLevel = $(level); // select all at this level
        $allAtLevel.each((_, el) => {
          let hasAnyHighlights = !!$(el).find('.search-highlight').length;
          let hasDirectHighlights = !!$(el).find(`${level}__hilitext .search-highlight`).length;
          if (hasDirectHighlights) {
            $(el).attr('data-search-match', 'direct');
          } else if (hasAnyHighlights) {
            $(el).attr('data-search-match', 'indirect');
          } else {
            $(el).attr('data-search-match', 'none');
          }
        });
      });
      $(document.body).toggleClass('no-search-results',
          !$('.sticker-root-section[data-search-match!="none"]').length);
      this.loadVisibleStickers();
    });
  }

  calcDrawSize(sticker) {
    // fit the sticker into a max width and height, keeping its aspect ratio
    let size = { width: sticker.width, height: sticker.height };
    if (size.width > MAX_DRAW_WIDTH) {
      size.height = size.height * MAX_DRAW_WIDTH / size.width;
      size.width = MAX_DRAW_WIDTH;
    }
    if (size.height > MAX_DRAW_HEIGHT) {
      size.width = size.width * MAX_DRAW_HEIGHT / size.height;
      size.height = MAX_DRAW_HEIGHT;
    }
    return size;
  }

  setupStickersUi() {
    $(document).on('mousedown', '.sticker__thumb', ev => {
      let stickerId = $(ev.target).parents('.sticker').attr('data-sticker-id');
      let rect = $(ev.target).get(0).getBoundingClientRect();
      rect = {
        x: rect.left,
        y: rect.top,
        width: rect.right - rect.left,
        height: rect.bottom - rect.top
      };
      StickersClient.startDragging(stickerId, rect);
    });

    this.setupStickerImageLoading();
  }

  setupStickerImageLoading() {
    this.loadVisibleStickers();
    $(window).on('DOMContentLoaded load resize', () => this.loadVisibleStickers());
    window.addEventListener('scroll', () => this.loadVisibleStickers(), true); // true == capture (all elements)
  }

  loadVisibleStickers() {
    this.fetchedImages = this.fetchedImages || new Set();
    $('.sticker').each((index, el) => {
      let $el = $(el);
      let stickerId = $el.attr('data-sticker-id');
      if ($el.attr('data-loaded')) {
        return;
      }

      if (!ElementVisibility.isElementInViewport(el)) {
        return;
      }

      this.fetchedImages.add(stickerId);
      StickersClient.getStickerImageUrl(stickerId).then(url => {
        $el.find('.sticker__thumb').attr('src', url).one('load', () => {
          $el.attr('data-loaded', true);
        });
      });
    });
  }
}

$(window).on('load', () => {
  new StickersPage();
});