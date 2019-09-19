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
    StickersClient.once('loaded', rawStickerIndex => {
      this.vue.stickerIndex = this.processRawStickerIndex(rawStickerIndex);
      this.vue.$nextTick(() => {
        $('.header-area__search-field').focus();
        this.loadVisibleStickers();
      });
    });
  }

  processRawStickerIndex(stickerIndex) {
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

    return stickerIndex;
  }

  setupCoreUi() {
    $(window).on('focus', () => {
      $('.header-area__search-field').focus().select();
    });
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

    function hiliteReplacer_() {
      return Array.from(arguments).slice(1, -2)
          .map((s, i) => i % 2 == 0
              ? `<span class="search-highlight">${s}</span>`
              : s)
          .join('');
    }

    Vue.component('hilitext', {
      template: `<div v-html="highlight(text, $globals.searchText)"></div>`,
      props: ['text'],
      methods: {
        highlight: (text, query) => {
          if (!query) {
            return text;
          }

          return String(text || '').replace(this.regexForSearchText(query), hiliteReplacer_);
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
              me.vueGlobal.searchText = '';
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

  regexForSearchText(query) {
    return new RegExp((query || '')
        .replace(/^\s+|\s+$/g, '')
        .split(/\s+/)
        .map(s => `(${s})`)
        .join('(.*?)'), 'ig');
  }

  updateSearch() {
    // TODO: move this to a watcher in vueGlobal
    this.vue.$nextTick(() => {
      const re = this.regexForSearchText(this.vueGlobal.searchText);
      const findIn = s => this.vueGlobal.searchText ? (s || '').search(re) >= 0 : true;

      const visitItem = item => {
        let found = false;
        if (item.items) {
          // section
          for (const subItem of item.items) {
            if (visitItem(subItem)) {
              found = true;
            }
          }
          if (findIn(item.title) || findIn(item.description)) {
            found = true;
            visitUnhide(item);
          }

        } else {
          // sticker
          found = findIn(item.name);
        }

        item._hide = !found;
        return found;
      };

      const visitUnhide = item => {
        if (item.items) {
          for (const subItem of item.items) {
            visitUnhide(subItem);
          }
        }

        item._hide = false;
      };

      let anyResults = false;
      for (const library of this.vue.stickerIndex.libraries) {
        let foundInLibrary = false;
        for (const section of library.sections) {
          let found;
          for (const row of section.rows) {
            if (visitItem(row)) {
              found = true;
            }
          }
          if (findIn(section.title) || findIn(section.description)) {
            found = true;
            for (const row of section.rows) {
              visitUnhide(row);
            }
          }
          section._hide = !found;
          anyResults = anyResults || found;
          foundInLibrary = foundInLibrary || found;
        }
        library._hide = !foundInLibrary;
      }

      this.vue.$forceUpdate();
      $(document.body).toggleClass('has-active-search', !!this.vueGlobal.searchText);
      $(document.body).toggleClass('no-search-results', !anyResults);
      this.vue.$nextTick(() => {
        this.loadVisibleStickers();
      });
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
    size.width = Math.max(1, size.width);
    size.height = Math.max(1, size.height);
    return size;
  }

  setupStickersUi() {
    $(document).on('mousedown', '.sticker__thumb-container', ev => {
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