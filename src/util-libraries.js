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

import * as util from './util';


/**
 * Returns the MSAssetLibrary / MSUserAssetLibrary with the given library ID
 * (which is a UUID)
 */
export function getLibraryById(libraryId, {onlyEnabled = false} = {}) {
  return util.arrayFromNSArray(getLibrariesController().libraries())
      .filter(lib => onlyEnabled ? !!lib.enabled() : true)
      .find(lib => String(lib.libraryID()) == String(libraryId));
}


/**
 * Adds the given .sketch file as a library in Sketch.
 */
export function addLibrary(context, librarySketchFilePath) {
  getLibrariesController().addAssetLibraryAtURL(NSURL.fileURLWithPath(librarySketchFilePath));
  getLibrariesController().notifyLibraryChange(
      getLibrariesController().userLibraries().firstObject()); // notify change on any lib
}


/**
 * Replaces all symbol instances and shared styles under (and including) the given parent layer with
 * those found in the given MSAssetLibrary.
 */
export function replaceSymbolsAndSharedStylesInLayerWithLibrary(
    parentDocument, parentLayer, library) {
  if (parentLayer.children) {
    let maybeImportForeignObjectWithId = objectId => {
      // TODO: is this valid/useful?
      // let existing = parentDocument.documentData().foreignSymbols()
      //     .find(fs => String(fs.symbolMaster().symbolID()) == String(symbolId));
      // if (existing) {
      //   return existing;
      // }

      let objectInLibrary = (
          library.document().symbolWithID(objectId) ||
          library.document().textStyleWithID(objectId) ||
          library.document().layerStyleWithID(objectId));
      if (objectInLibrary) {
        let foreignObject = objectInLibrary.foreignObject();

        if (foreignObject) {
          // the shared obj in the target library is a foreign obj from yet
          // another library, try to import it from the other library, and if
          // unavailable, grab the MSForeignObject and add it to the target
          // document directly
          let nestedLibrary = getLibraryById(foreignObject.libraryID(), {onlyEnabled: true});
          if (nestedLibrary) {
            let objectInNestedLibrary = (
                nestedLibrary.document().symbolWithID(foreignObject.remoteShareID()) ||
                nestedLibrary.document().textStyleWithID(foreignObject.remoteShareID()) ||
                nestedLibrary.document().layerStyleWithID(foreignObject.remoteShareID()) ||
                objectInLibrary /* worst case, just try to import the object in the outer lib */);
            return importObjectFromLibrary(objectInNestedLibrary, nestedLibrary,
                parentDocument.documentData());
          } else {
            if (objectInLibrary instanceof MSSymbolMaster) {
              // TODO: investigate what other dependencies we may need to bring in
              // when calling addForeignXX() on a foreign object from another doc.
              // likely we need to add other foreign objects that this one relies on
              parentDocument.documentData().addForeignSymbol(foreignObject);
              return foreignObject;
            } /*else if (objectInLibrary instanceof MSTextStyle) {
              parentDocument.documentData().addForeignTextStyle(foreignObject);
            } else if (objectInLibrary instanceof MSLayerStyle) {
              parentDocument.documentData().addForeignLayerStyle(foreignObject);
            }*/
          }
        }

        // the symbol in the target library is local to the library, import it
        // from the library
        return importObjectFromLibrary(objectInLibrary, library,
            parentDocument.documentData());
      }

      return null;
    };

    // Deep import is necessary when importing override symbols that themselves have overrides
    // This method returns a mapping from local to foreign ID
    let deepImportOverrides = (overridesDict) => {
      let localToForeignIdMap = {};
      for (let k in overridesDict) {
        let foreignObject = maybeImportForeignObjectWithId(overridesDict[k]);
        if (foreignObject) {
          // swap out the symbol ID that's local to the library for the symbol ID
          // for the foreign symbol in the new document linked to the library
          localToForeignIdMap[String(overridesDict[k])] = String(foreignObject.localShareID());
        }

        localToForeignIdMap = Object.assign(
            localToForeignIdMap,
            deepImportOverrides(overridesDict[k]));
      }
      return localToForeignIdMap;
    };

    let allSymbolInstances =  util.getAllLayersMatchingPredicate(
        parentLayer, NSPredicate.predicateWithFormat('className == %@', 'MSSymbolInstance'));
    allSymbolInstances.forEach(symbolInstance => {
      let symbolId = symbolInstance.symbolID();
      let foreignSymbol = maybeImportForeignObjectWithId(symbolId);
      if (foreignSymbol) {
        symbolInstance.changeInstanceToSymbol(foreignSymbol.symbolMaster());
        replaceSymbolsAndSharedStylesInLayerWithLibrary(
            parentDocument, foreignSymbol.symbolMaster(), library);
      }

      let overrides = util.dictFromNSDict(symbolInstance.overrides());
      let localToForeignSharedObjectIdMap = deepImportOverrides(overrides);

      symbolInstance.updateOverridesWithObjectIDMap(localToForeignSharedObjectIdMap);
    });

    let allLayersWithSharedStyle = util.getAllLayersMatchingPredicate(
        parentLayer, NSPredicate.predicateWithFormat('sharedStyleID != nil'));
    allLayersWithSharedStyle.forEach(layerWithSharedStyle => {
      let styleId = layerWithSharedStyle.sharedStyleID();
      let foreignSharedStyle = maybeImportForeignObjectWithId(styleId);
      if (foreignSharedStyle) {
        if (layerWithSharedStyle instanceof MSTextLayer) {
          // preserve formatted string value before setting shared style (which resets
          // character-level formatting)
          let aStr = layerWithSharedStyle.attributedStringValue();
          layerWithSharedStyle.setSharedStyle(foreignSharedStyle.localSharedStyle());
          layerWithSharedStyle.setAttributedStringValue(aStr);
        } else { // inherits MSStyledLayer
          let style = layerWithSharedStyle.style().copy();
          layerWithSharedStyle.setSharedStyle(foreignSharedStyle.localSharedStyle());
          layerWithSharedStyle.setStyle(style);
        }
      }
    });
  }
}


/**
 * Compatibility layer for importForeignSymbol_fromLibrary_intoDocument,
 * removed in Sketch 50.
 *
 * @param {MSModelObject} libraryObject The object (e.g. symbol master, style) in library to import
 * @param {MSAssetLibrary} library The library to import from
 * @param {MSDocumentData} parentDocumentData The document data to import into
 * @returns {MSForeignObject}
 */
function importObjectFromLibrary(libraryObject, library, parentDocumentData) {
  let librariesController = getLibrariesController();
  let shareableObjectReference = MSShareableObjectReference.referenceForShareableObject_inLibrary(
      libraryObject, library);
  return librariesController.importShareableObjectReference_intoDocument(
      shareableObjectReference, parentDocumentData);
}


/**
 * Returns an MSDocument for the library with the given ID (cached).
 * Note: this operation may take a while.
 */
export function docForLibraryId(libraryId) {
  docForLibraryId.__cache__ = docForLibraryId.__cache__ || {};
  if (!(libraryId in docForLibraryId.__cache__)) {
    let library = Array.from(getLibrariesController().libraries())
        .find(lib => String(lib.libraryID()) == libraryId);
    if (!library) {
      return null;
    }

    docForLibraryId.__cache__[libraryId] = utils.loadDocFromSketchFile(
        String(library.locationOnDisk().path()));
  }

  return docForLibraryId.__cache__[libraryId];
}


/**
 * Gets the app instance's MSAssetLibraryController
 */
function getLibrariesController() {
  return AppController.sharedInstance().librariesController();
}
