;(function(Namespace, undefined) {
    "use strict";
    var vec3 = glMatrix.vec3;   

/**
 * @classdesc
 * This class is responsible for loading tiff label files into a volume.
 * It requires the UTIF library.
 * 
 * @constructor
 * @param {Boolean} reverseSort - Whether to sort the files in reverse order.
 */
Namespace.LabelLoader = function(opts = {}) 
{
    // Inherit from Loader3D
    BigLime.Loader3D.call(this);

    this.fileList = [];
    this.reverseSort = !!opts.reverseSort;
    this.numLabelsFound = 0;
};
Namespace.LabelLoader.prototype = Object.create(BigLime.Loader3D.prototype);
Namespace.LabelLoader.prototype.constructor = Namespace.LabelLoader;  


/**
 * Starts loading files into a volume object.
 * 
 * @param {FileList|File} imgFiles - The image File object(s) to load.
 * @param {Volume} volume - The volume object that will receive the data.
 * @param {function} [completionCb] - A callback to invoke when loading is complete.
 * @param {function} [progressCb] - A callback to invoke when each image is loaded.
 */
Namespace.LabelLoader.prototype.loadImagesIntoVolume = function (imgFiles, volume, completionCb, progressCb) 
{
    this.fileList = [];
    Array.prototype.push.apply(this.fileList, imgFiles); // Take a copy of the file list, since it may be transient

    this.vol = volume;
    this.errors = null;
    this.warnings = null;
    this.done = false;
    this.loadCompleteCb = completionCb;
    this.loadProgressCb = progressCb;
    this.numLabelsFound = 0;

    // Handle a trivial case
    if (!this.fileList || !this.fileList.length) {
        this.done = true;
        this.warnings = "LabelLoader: No files were loaded, because the supplied file list was empty.";
        BigLime.Utils.SafeInvoke(this.loadCompleteCb, [this]); 
        return;
    }

    // Check that all items in the file list are valid
    if (this.fileList.some(f => {return !(f instanceof FileSystemFileHandle) && !(f instanceof File)})) {
        this.done = true;
        this.errors = "LabelLoader: Invalid item in file list.";
        BigLime.Utils.SafeInvoke(this.loadCompleteCb, [this]);   
        return;
    }

    BigLime.Utils.SafeInvoke(this.loadProgressCb, [0, this.fileList.length]);

    // Load the multi-image tiff file
    var fileReader = new FileReader();  
    fileReader.onload = function() { this._handleMultiImageTiff(fileReader); }.bind(this);
    fileReader.onerror = function() { this._onImageLoadingError(fileReader); }.bind(this);  
    if (this.fileList[0] instanceof FileSystemFileHandle) {
        this.fileList[0].getFile().then(function(file) { 
            fileReader.readAsArrayBuffer(file); 
        })
        .catch (function(ex) {
            this._onImageLoadingError(fileReader)}.bind(this)
        );
    }
    else {
        fileReader.readAsArrayBuffer(this.fileList[0]);
    }
    
};


/**
 * Loads a multi-image tiff file.
 * @private
 * 
 */
Namespace.LabelLoader.prototype._handleMultiImageTiff = async function(fileReader) 
{
    if (this.cancelled) { return; } 

    var ifds = UTIF.decode(fileReader.result);
    var fileBytes = fileReader.result;
    
    try
    {
        UTIF.decodeImage(fileBytes, ifds[0]);
        var imgWidth = ifds[0].width;
        var imgHeight = ifds[0].height;
        var numImgs = ifds.length;
        var bpp = ifds[0].t258[0];   
        var wh = imgWidth * imgHeight;
  
        if (bpp != 8) {
            this.errors = "LabelLoader: Only 8-bit images are supported.";
            this.done = true;
            BigLime.Utils.SafeInvoke(this.loadCompleteCb, [this]);
            return;       
        } 

        // Decode and copy pixel data into local array
        const imgBufferArray = new Array(numImgs);    
        const unlabeled = 0, background = 1, foreground = 2, seedVal = 255;
        for (let z = 0; z < numImgs; z++) {
            UTIF.decodeImage(fileBytes, ifds[z]);
            var arr = imgBufferArray[z] = new Uint8Array(ifds[z].data.buffer); 
            for (let j=0; j<wh; j++) { 
                const val = arr[j];
                arr[j] = (val == 2) ? unlabeled : (val == 1) ? foreground : (val == 0) ? background : val;
            }  // Remap (0,1,2) -> (1,2,0)

            // Maybe report progress
            if (this.loadProgressCb) {
                BigLime.Utils.SafeInvoke(this.loadProgressCb, [z, numImgs]);
                await new Promise(r => setTimeout(r, 5));
                if (this.cancelled) { return; } 
            }
        }

        // Find connected components, labeling each component with a unique number
        let compValue = 3;
        for (let z = 0; z < numImgs; z++) {
            const bufz = imgBufferArray[z];
            for (let y = 0; y < imgHeight; y++) { 
                for (let x = 0; x < imgWidth; x++) {
                    const nxy = y*imgWidth + x;
                    if (bufz[nxy] != foreground) { continue; }
                    bufz[nxy] = seedVal; // Indicates a seed
                    const seeds = [x, y, z];
            
                    while (seeds.length > 0)
                    {
                        const seedZ = seeds.pop();
                        const seedY = seeds.pop();
                        const seedX = seeds.pop();
                        imgBufferArray[seedZ][seedY*imgWidth + seedX] = compValue;
                        for (var dz=-1; dz<=1; dz++)
                        {
                            const zp = seedZ + dz;
                            if (zp<0 || zp>=numImgs) { continue; }
                            const bufzp = imgBufferArray[zp];
                            for (var dy=-1; dy<=1; dy++)
                            {
                                var yp = seedY + dy;
                                if (yp<0 || yp>=imgHeight) { continue; }
                                var ypw = yp*imgWidth;

                                    // Unrolled inner loop:
                                    var xp = seedX - 1;
                                    if (xp >= 0) { 
                                        if (bufzp[ypw + xp] == foreground) { 
                                            seeds.push(xp, yp, zp);
                                            bufzp[ypw + xp] = seedVal;
                                        }
                                    }

                                    xp = seedX;
                                    if (bufzp[ypw + xp] == foreground) { 
                                        seeds.push(xp, yp, zp);
                                        bufzp[ypw + xp] = seedVal;
                                    }

                                    xp = seedX + 1;
                                    if (xp < imgWidth) { 
                                        if (bufzp[ypw + xp] == foreground) { 
                                            seeds.push(xp, yp, zp);
                                            bufzp[ypw + xp] = seedVal;
                                        }
                                    }
                            }   
                        }     
                    }
                    compValue++;
                    if (compValue >= seedVal) { 
                        tooManyComponents = true;
                        this.errors = "LabelLoader: Volume has too many connected components.";
                        this.done = true;
                        BigLime.Utils.SafeInvoke(this.loadCompleteCb, [this]);
                        return;       
                    }
                }
            }
        }
        this.numLabelsFound = compValue - 3;
        
        // Copy modified images to texture
        var dims = [imgWidth, imgHeight, numImgs];     
        this.errors = this.vol.loadBegin(dims, bpp, 'little');   
        if (this.errors) {
            this.done = true;
            BigLime.Utils.SafeInvoke(this.loadCompleteCb, [this]);
            return;       
        } 
        const batchInfo = { startIndex:0, endIndex:numImgs, imgBuffers:imgBufferArray };
        this._copyImagesToTexture(batchInfo);

        if (!this.done) {
            this.done = true; 
            this.vol.loadEnd();
            BigLime.Utils.SafeInvoke(this.loadCompleteCb, [this]);           
            return;
        }
    }
    catch (ex) {
        this._onImageLoadingError(ex);
    }
};


/**
 * Callback invoked when an error occurs during image loading.
 * @private
 * 
 */
Namespace.LabelLoader.prototype._onImageLoadingError = function (arg) 
{
    if (this.cancelled  || this.done) { return; } 

    this.done = true;
    if (arg instanceof FileReader) {
        this.errors = "Error loading image " + (arg ? arg.fileName || "" : "");
    }
    else if (arg.message) { 
        this.errors = arg.message; 
    }
    else {
        this.errors = "Error loading image.";
    }
    BigLime.Utils.SafeInvoke(this.loadCompleteCb, [this]); 
};

})( window.ScrollSlabViewer = window.ScrollSlabViewer || {} );



