/*****************************************************************************
 * Open MCT Web, Copyright (c) 2014-2015, United States Government
 * as represented by the Administrator of the National Aeronautics and Space
 * Administration. All rights reserved.
 *
 * Open MCT Web is licensed under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 * http://www.apache.org/licenses/LICENSE-2.0.
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS, WITHOUT
 * WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the
 * License for the specific language governing permissions and limitations
 * under the License.
 *
 * Open MCT Web includes source code licensed under additional open source
 * licenses. See the Open Source Licenses file (LICENSES.md) included with
 * this source code distribution or the Licensing information page available
 * at runtime from the About dialog for additional information.
 *****************************************************************************/

/*global define */

define(
    ["../../../commonUI/browse/lib/uuid"],
    function (uuid) {
        "use strict";

        /**
         * CopyService provides an interface for deep copying objects from one
         * location to another.  It also provides a method for determining if
         * an object can be copied to a specific location.
         * @constructor
         * @memberof platform/entanglement
         * @implements {platform/entanglement.AbstractComposeService}
         */
        function CopyService($q, creationService, policyService, persistenceService) {
            this.$q = $q;
            this.creationService = creationService;
            this.policyService = policyService;
            this.persistenceService = persistenceService;
        }

        CopyService.prototype.validate = function (object, parentCandidate) {
            if (!parentCandidate || !parentCandidate.getId) {
                return false;
            }
            if (parentCandidate.getId() === object.getId()) {
                return false;
            }
            return this.policyService.allow(
                "composition",
                parentCandidate.getCapability('type'),
                object.getCapability('type')
            );
        };

        /**
         * Will build a graph of an object and all of its child objects in
         * memory
         * @param domainObject The original object to be copied
         * @param parent The parent of the original object to be copied
         * @returns {Promise} resolved with an array of clones of the models
         * of the object tree being copied. Copying is done in a bottom-up
         * fashion, so that the last member in the array is a clone of the model
         * object being copied. The clones are all full composed with
         * references to their own children.
         */
        CopyService.prototype.buildCopyPlan = function(domainObject, parent) {
            var clones = [],
                $q = this.$q,
                self = this;
            
            function makeClone(object) {
                return JSON.parse(JSON.stringify(object));
            }

            /**
             * A recursive function that will perform a bottom-up copy of
             * the object tree with originalObject at the root. Recurses to
             * the farthest leaf, then works its way back up again,
             * cloning objects, and composing them with their child clones
             * as it goes
             * @param originalObject
             * @param originalParent
             * @returns {*}
             */
            function copy(originalObject, originalParent) {
                //Make a clone of the model of the object to be copied
                var modelClone = makeClone(originalObject.getModel());
                modelClone.composition = [];
                modelClone.id = uuid();
                return $q.when(originalObject.useCapability('composition')).then(function(composees){
                    return (composees || []).reduce(function(promise, composee){
                            //If the object is composed of other
                            // objects, chain a promise..
                            return promise.then(function(){
                                // ...to recursively copy it (and its children)
                                return copy(composee, originalObject).then(function(composeeClone){
                                    //Once copied, associate each cloned
                                    // composee with its parent clone
                                    composeeClone.location = modelClone.id;
                                    return modelClone.composition.push(composeeClone.id);
                                });
                            });}, $q.when(undefined)
                    ).then(function (){
                            //Add the clone to the list of clones that will
                            //be returned by this function
                            clones.push({
                                model: modelClone,
                                persistenceSpace: originalParent.getCapability('persistence')
                            });
                            return modelClone;
                        });
                });

            };
            return copy(domainObject, parent).then(function(){
                return clones;
            });
        }

        /**
         * Will persist a list of {@link objectClones}.
         * @private
         * @param progress
         * @returns {Function} a function that will perform the persistence
         * with a progress callback curried into it.
         */
        CopyService.prototype.persistObjects = function(progress) {
            var persisted = 0,
                self = this;
            return function(objectClones) {
                return self.$q.all(objectClones.map(function(clone, index){
                    return self.persistenceService.createObject(clone.persistenceSpace, clone.model.id, clone.model)
                        .then(function(){
                            progress("copying", objectClones.length, ++persisted);
                        });
                })).then(function(){ return objectClones});
            }
        }

        /**
         * Will add a list of clones to the specified parent's composition
         * @private
         * @param parent
         * @param progress
         * @returns {Function}
         */
        CopyService.prototype.addClonesToParent = function(parent, progress) {
            var self = this;
            return function(clones) {
                var parentClone = clones[clones.length-1];
                parentClone.model.location = parent.getId()
                return self.$q.when(
                    parent.hasCapability('composition') &&
                    parent.getCapability('composition').add(parentClone.model.id)
                        .then(function(){
                            parent.getCapability("persistence").persist()
                        }));
            }
        }

        /**
         * Creates a duplicate of the object tree starting at domainObject to
         * the new parent specified.
         * @param domainObject
         * @param parent
         * @param progress
         * @returns a promise that will be completed when the duplication is
         * successful, otherwise an error is thrown.
         */
        CopyService.prototype.perform = function (domainObject, parent, progress) {
            var $q = this.$q,
                self = this;
            if (this.validate(domainObject, parent)) {
                progress("preparing");
                return this.buildCopyPlan(domainObject, parent)
                    .then(self.persistObjects(progress))
                    .then(self.addClonesToParent(parent, progress));
            } else {
                throw new Error(
                    "Tried to copy objects without validating first."
                );
            }
        }

        return CopyService;
    }
);

