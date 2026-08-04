const HEVC_SPS_NAL_UNIT_TYPE = 33;
const MAXIMUM_HEVC_CODED_DIMENSION = 16_384;
const MAXIMUM_HEVC_DPB_PICTURE_COUNT = 16;
const MAXIMUM_HEVC_REFERENCE_PICTURE_COUNT = MAXIMUM_HEVC_DPB_PICTURE_COUNT;
const MAXIMUM_HEVC_SHORT_TERM_REFERENCE_PICTURE_SET_COUNT = 64;
const MAXIMUM_SPS_NAL_UNIT_BYTE_LENGTH = 64 * 1024;
const MAXIMUM_UNSIGNED_EXP_GOLOMB_VALUE = 0x7FFF_FFFF;
const MAIN_PROFILE_BASE_DPB_PICTURE_COUNT = 6;
const MAXIMUM_SOFTWARE_DECODE_CODED_HEIGHT = 2_160;
const MAXIMUM_SOFTWARE_DECODE_CODED_WIDTH = 3_840;
// Bound retained luma to six maximum-size 4K pictures
// Main10 4:2:0 samples for that budget occupy about 150 MB
const MAXIMUM_SOFTWARE_DECODE_DPB_LUMA_SAMPLE_COUNT =
    MAXIMUM_SOFTWARE_DECODE_CODED_WIDTH
    * MAXIMUM_SOFTWARE_DECODE_CODED_HEIGHT
    * MAIN_PROFILE_BASE_DPB_PICTURE_COUNT;
const HEVC_LEVEL_MAXIMUM_LUMA_PICTURE_SAMPLE_COUNTS: Readonly<Partial<Record<number, number>>> =
    Object.freeze({
        30: 36_864,
        60: 122_880,
        63: 245_760,
        90: 552_960,
        93: 983_040,
        120: 2_228_224,
        123: 2_228_224,
        150: 8_912_896,
        153: 8_912_896,
        156: 8_912_896,
        180: 35_651_584,
        183: 35_651_584,
        186: 35_651_584
    });

export type HEVCSPSColorSpace = {
    fullRange: boolean
    matrix: 'bt2020-ncl' | 'bt709'
    primaries: 'bt2020' | 'bt709'
    transfer: 'bt709' | 'hlg' | 'pq'
};

export type HEVCSPSConfiguration = {
    bitDepth: 8 | 10
    chromaFormat: 1
    codedHeight: number
    codedWidth: number
    colorSpace: HEVCSPSColorSpace | null
    displayHeight: number
    displayWidth: number
    levelIDC: number
    maximumDPBPictureCount: number
    profileIDC: 1 | 2
    progressive: true
};

export type HEVCHDRTransfer = 'hlg' | 'pq';

class BoundedBitReader {
    private bitOffset = 0;

    public constructor(private readonly bytes: Uint8Array) {}

    public readBits(bitCount: number, label: string): number {
        if (!Number.isSafeInteger(bitCount) || bitCount < 0 || bitCount > 32) {
            throw new TypeError(`The HEVC SPS ${label} bit count is invalid`);
        }
        if (this.bitOffset + bitCount > this.bytes.byteLength * 8) {
            throw new TypeError(`The HEVC SPS ends inside ${label}`);
        }

        let value = 0;
        for (let bitIndex = 0; bitIndex < bitCount; bitIndex += 1) {
            const byteOffset = Math.floor(this.bitOffset / 8);
            const shift = 7 - (this.bitOffset % 8);
            value = (value * 2) + ((this.bytes[byteOffset] >> shift) & 1);
            this.bitOffset += 1;
        }
        return value;
    }

    public readFlag(label: string): boolean {
        return this.readBits(1, label) === 1;
    }

    public getBitOffset(): number {
        return this.bitOffset;
    }

    public readUnsignedExpGolomb(label: string, maximumValue: number): number {
        let leadingZeroBitCount = 0;
        while (!this.readFlag(label)) {
            leadingZeroBitCount += 1;
            if (leadingZeroBitCount > 31) {
                throw new TypeError(`The HEVC SPS ${label} value is too large`);
            }
        }

        const suffix = this.readBits(leadingZeroBitCount, label);
        const value = ((2 ** leadingZeroBitCount) - 1) + suffix;
        if (!Number.isSafeInteger(value) || value > maximumValue) {
            throw new TypeError(`The HEVC SPS ${label} value is unsupported`);
        }
        return value;
    }

    public skipBits(bitCount: number, label: string): void {
        if (!Number.isSafeInteger(bitCount) || bitCount < 0) {
            throw new TypeError(`The HEVC SPS ${label} bit count is invalid`);
        }
        if (this.bitOffset + bitCount > this.bytes.byteLength * 8) {
            throw new TypeError(`The HEVC SPS ends inside ${label}`);
        }
        this.bitOffset += bitCount;
    }
}

type ProfileTierLevel = {
    interlacedSource: boolean
    levelIDC: number
    profileIDC: number
    progressiveSource: boolean
};

type ParsedVUI = {
    colorDescriptionOffsets: VUIColorDescriptionOffsets | null
    colorSpace: HEVCSPSColorSpace | null
    fieldSequence: boolean
};

type VUIColorDescriptionOffsets = {
    fullRange: number
    matrix: number
    primaries: number
    transfer: number
};

function createRBSP(nalUnit: Uint8Array): Uint8Array {
    if (
        nalUnit.byteLength < 4
        || nalUnit.byteLength > MAXIMUM_SPS_NAL_UNIT_BYTE_LENGTH
        || ((nalUnit[0] >> 1) & 0x3F) !== HEVC_SPS_NAL_UNIT_TYPE
        || (nalUnit[0] & 0x80) !== 0
        || (nalUnit[1] & 0x07) === 0
    ) {
        throw new TypeError('The HEVC SPS NAL unit header is invalid');
    }

    const rbspBytes: number[] = [];
    for (let byteIndex = 2; byteIndex < nalUnit.byteLength; byteIndex += 1) {
        const byteValue = nalUnit[byteIndex];
        if (
            byteValue === 3
            && byteIndex >= 4
            && nalUnit[byteIndex - 1] === 0
            && nalUnit[byteIndex - 2] === 0
        ) {
            const nextByte = nalUnit[byteIndex + 1];
            if (byteIndex + 1 >= nalUnit.byteLength || nextByte > 3) {
                throw new TypeError('The HEVC SPS has an invalid emulation-prevention byte');
            }
            continue;
        }
        rbspBytes.push(byteValue);
    }
    if (rbspBytes.length === 0) {
        throw new TypeError('The HEVC SPS RBSP is empty');
    }
    return new Uint8Array(rbspBytes);
}

function parseProfileTierLevel(
    reader: BoundedBitReader,
    maximumSubLayerIndex: number
): ProfileTierLevel {
    reader.skipBits(2, 'general_profile_space');
    reader.skipBits(1, 'general_tier_flag');
    const profileIDC = reader.readBits(5, 'general_profile_idc');
    reader.skipBits(32, 'general_profile_compatibility_flags');
    const progressiveSource = reader.readFlag('general_progressive_source_flag');
    const interlacedSource = reader.readFlag('general_interlaced_source_flag');
    reader.skipBits(46, 'general_constraint_indicator_flags');
    const levelIDC = reader.readBits(8, 'general_level_idc');

    const subLayerProfilePresent: boolean[] = [];
    const subLayerLevelPresent: boolean[] = [];
    for (let subLayerIndex = 0; subLayerIndex < maximumSubLayerIndex; subLayerIndex += 1) {
        subLayerProfilePresent.push(reader.readFlag('sub_layer_profile_present_flag'));
        subLayerLevelPresent.push(reader.readFlag('sub_layer_level_present_flag'));
    }
    if (maximumSubLayerIndex > 0) {
        reader.skipBits(2 * (8 - maximumSubLayerIndex), 'reserved_zero_2bits');
    }
    for (let subLayerIndex = 0; subLayerIndex < maximumSubLayerIndex; subLayerIndex += 1) {
        if (subLayerProfilePresent[subLayerIndex]) {
            reader.skipBits(88, 'sub_layer_profile_tier_level');
        }
        if (subLayerLevelPresent[subLayerIndex]) {
            reader.skipBits(8, 'sub_layer_level_idc');
        }
    }

    return { interlacedSource, levelIDC, profileIDC, progressiveSource };
}

function skipScalingListData(reader: BoundedBitReader): void {
    for (let sizeIndex = 0; sizeIndex < 4; sizeIndex += 1) {
        const matrixCount = sizeIndex === 3 ? 2 : 6;
        for (let matrixIndex = 0; matrixIndex < matrixCount; matrixIndex += 1) {
            if (!reader.readFlag('scaling_list_pred_mode_flag')) {
                reader.readUnsignedExpGolomb(
                    'scaling_list_pred_matrix_id_delta',
                    MAXIMUM_UNSIGNED_EXP_GOLOMB_VALUE
                );
                continue;
            }

            const coefficientCount = Math.min(64, 1 << (4 + (2 * sizeIndex)));
            if (sizeIndex > 1) {
                reader.readUnsignedExpGolomb(
                    'scaling_list_dc_coef_minus8',
                    MAXIMUM_UNSIGNED_EXP_GOLOMB_VALUE
                );
            }
            for (let coefficientIndex = 0;
                coefficientIndex < coefficientCount;
                coefficientIndex += 1
            ) {
                reader.readUnsignedExpGolomb(
                    'scaling_list_delta_coef',
                    MAXIMUM_UNSIGNED_EXP_GOLOMB_VALUE
                );
            }
        }
    }
}

function parseExplicitReferencePictureSet(reader: BoundedBitReader): number {
    const negativePictureCount = reader.readUnsignedExpGolomb(
        'num_negative_pics',
        MAXIMUM_HEVC_REFERENCE_PICTURE_COUNT
    );
    const positivePictureCount = reader.readUnsignedExpGolomb(
        'num_positive_pics',
        MAXIMUM_HEVC_REFERENCE_PICTURE_COUNT
    );
    const deltaPictureCount = negativePictureCount + positivePictureCount;
    if (deltaPictureCount > MAXIMUM_HEVC_REFERENCE_PICTURE_COUNT) {
        throw new TypeError('The HEVC SPS reference picture set is too large');
    }
    for (let pictureIndex = 0; pictureIndex < deltaPictureCount; pictureIndex += 1) {
        reader.readUnsignedExpGolomb(
            'delta_poc_minus1',
            MAXIMUM_UNSIGNED_EXP_GOLOMB_VALUE
        );
        reader.skipBits(1, 'used_by_curr_pic_flag');
    }
    return deltaPictureCount;
}

function parsePredictedReferencePictureSet(
    reader: BoundedBitReader,
    referenceDeltaPictureCount: number
): number {
    reader.skipBits(1, 'delta_rps_sign');
    reader.readUnsignedExpGolomb('abs_delta_rps_minus1', MAXIMUM_UNSIGNED_EXP_GOLOMB_VALUE);
    let deltaPictureCount = 0;
    for (let pictureIndex = 0;
        pictureIndex <= referenceDeltaPictureCount;
        pictureIndex += 1
    ) {
        const usedByCurrentPicture = reader.readFlag('used_by_curr_pic_flag');
        if (usedByCurrentPicture || reader.readFlag('use_delta_flag')) {
            deltaPictureCount += 1;
        }
    }
    if (deltaPictureCount > MAXIMUM_HEVC_REFERENCE_PICTURE_COUNT) {
        throw new TypeError('The HEVC SPS predicted reference picture set is too large');
    }
    return deltaPictureCount;
}

function parseShortTermReferencePictureSets(
    reader: BoundedBitReader,
    setCount: number
): void {
    const deltaPictureCounts: number[] = [];
    for (let setIndex = 0; setIndex < setCount; setIndex += 1) {
        const predicted = setIndex > 0
            && reader.readFlag('inter_ref_pic_set_prediction_flag');
        const deltaPictureCount = predicted ?
            parsePredictedReferencePictureSet(reader, deltaPictureCounts[setIndex - 1]) :
            parseExplicitReferencePictureSet(reader);
        deltaPictureCounts.push(deltaPictureCount);
    }
}

function mapColorSpace(
    primariesValue: number,
    transferValue: number,
    matrixValue: number,
    fullRange: boolean
): HEVCSPSColorSpace {
    if (primariesValue === 1 && transferValue === 1 && matrixValue === 1) {
        return {
            fullRange,
            matrix: 'bt709',
            primaries: 'bt709',
            transfer: 'bt709'
        };
    }
    if (primariesValue === 9 && matrixValue === 9) {
        switch (transferValue) {
            case 16:
                return {
                    fullRange,
                    matrix: 'bt2020-ncl',
                    primaries: 'bt2020',
                    transfer: 'pq'
                };
            case 18:
                return {
                    fullRange,
                    matrix: 'bt2020-ncl',
                    primaries: 'bt2020',
                    transfer: 'hlg'
                };
        }
    }
    throw new TypeError('The HEVC SPS VUI color description is unsupported');
}

function parseVUI(reader: BoundedBitReader): ParsedVUI {
    if (reader.readFlag('aspect_ratio_info_present_flag')) {
        const aspectRatioIDC = reader.readBits(8, 'aspect_ratio_idc');
        if (aspectRatioIDC === 255) {
            reader.skipBits(32, 'sar_width_and_height');
        }
    }
    if (reader.readFlag('overscan_info_present_flag')) {
        reader.skipBits(1, 'overscan_appropriate_flag');
    }
    let colorDescriptionOffsets: VUIColorDescriptionOffsets | null = null;
    let colorSpace: HEVCSPSColorSpace | null = null;
    if (reader.readFlag('video_signal_type_present_flag')) {
        reader.skipBits(3, 'video_format');
        const fullRangeOffset = reader.getBitOffset();
        const fullRange = reader.readFlag('video_full_range_flag');
        if (reader.readFlag('colour_description_present_flag')) {
            const primariesOffset = reader.getBitOffset();
            const primariesValue = reader.readBits(8, 'colour_primaries');
            const transferOffset = reader.getBitOffset();
            const transferValue = reader.readBits(8, 'transfer_characteristics');
            const matrixOffset = reader.getBitOffset();
            const matrixValue = reader.readBits(8, 'matrix_coeffs');
            colorDescriptionOffsets = {
                fullRange: fullRangeOffset,
                matrix: matrixOffset,
                primaries: primariesOffset,
                transfer: transferOffset
            };
            colorSpace = mapColorSpace(
                primariesValue,
                transferValue,
                matrixValue,
                fullRange
            );
        }
    }

    if (reader.readFlag('chroma_loc_info_present_flag')) {
        reader.readUnsignedExpGolomb(
            'chroma_sample_loc_type_top_field',
            MAXIMUM_UNSIGNED_EXP_GOLOMB_VALUE
        );
        reader.readUnsignedExpGolomb(
            'chroma_sample_loc_type_bottom_field',
            MAXIMUM_UNSIGNED_EXP_GOLOMB_VALUE
        );
    }
    reader.skipBits(1, 'neutral_chroma_indication_flag');
    const fieldSequence = reader.readFlag('field_seq_flag');
    reader.skipBits(1, 'frame_field_info_present_flag');

    return {
        colorDescriptionOffsets,
        colorSpace,
        fieldSequence
    };
}

type SPSDimensions = {
    codedHeight: number
    codedWidth: number
    displayHeight: number
    displayWidth: number
};

function parseSPSDimensions(reader: BoundedBitReader): SPSDimensions {
    const codedWidth = reader.readUnsignedExpGolomb(
        'pic_width_in_luma_samples',
        MAXIMUM_HEVC_CODED_DIMENSION
    );
    const codedHeight = reader.readUnsignedExpGolomb(
        'pic_height_in_luma_samples',
        MAXIMUM_HEVC_CODED_DIMENSION
    );
    if (codedWidth <= 0 || codedHeight <= 0) {
        throw new TypeError('The HEVC SPS coded dimensions are invalid');
    }
    if (!reader.readFlag('conformance_window_flag')) {
        return {
            codedHeight,
            codedWidth,
            displayHeight: codedHeight,
            displayWidth: codedWidth
        };
    }

    const leftOffset = reader.readUnsignedExpGolomb(
        'conf_win_left_offset',
        MAXIMUM_HEVC_CODED_DIMENSION
    );
    const rightOffset = reader.readUnsignedExpGolomb(
        'conf_win_right_offset',
        MAXIMUM_HEVC_CODED_DIMENSION
    );
    const topOffset = reader.readUnsignedExpGolomb(
        'conf_win_top_offset',
        MAXIMUM_HEVC_CODED_DIMENSION
    );
    const bottomOffset = reader.readUnsignedExpGolomb(
        'conf_win_bottom_offset',
        MAXIMUM_HEVC_CODED_DIMENSION
    );
    const displayWidth = codedWidth - (2 * (leftOffset + rightOffset));
    const displayHeight = codedHeight - (2 * (topOffset + bottomOffset));
    if (displayWidth <= 0 || displayHeight <= 0) {
        throw new TypeError('The HEVC SPS conformance window is invalid');
    }
    return { codedHeight, codedWidth, displayHeight, displayWidth };
}

function parseSPSBitDepth(reader: BoundedBitReader): {
    bitDepth: 8 | 10
    log2MaximumPictureOrderCountLSBMinus4: number
} {
    const lumaBitDepth = 8 + reader.readUnsignedExpGolomb('bit_depth_luma_minus8', 6);
    const chromaBitDepth = 8 + reader.readUnsignedExpGolomb('bit_depth_chroma_minus8', 6);
    if (
        lumaBitDepth !== chromaBitDepth
        || (lumaBitDepth !== 8 && lumaBitDepth !== 10)
    ) {
        throw new TypeError('The HEVC SPS bit depth is unsupported');
    }
    return {
        bitDepth: lumaBitDepth,
        log2MaximumPictureOrderCountLSBMinus4: reader.readUnsignedExpGolomb(
            'log2_max_pic_order_cnt_lsb_minus4',
            12
        )
    };
}

function getMaximumDPBPictureCount(
    levelIDC: number,
    codedWidth: number,
    codedHeight: number
): number {
    const pictureSampleCount = codedWidth * codedHeight;
    if (!Number.isSafeInteger(pictureSampleCount) || pictureSampleCount <= 0) {
        throw new TypeError('The HEVC SPS picture sample count is invalid');
    }
    const implementationMaximum = Math.max(
        1,
        Math.min(
            MAXIMUM_HEVC_DPB_PICTURE_COUNT,
            Math.floor(MAXIMUM_SOFTWARE_DECODE_DPB_LUMA_SAMPLE_COUNT / pictureSampleCount)
        )
    );
    const levelMaximumPictureSampleCount =
        HEVC_LEVEL_MAXIMUM_LUMA_PICTURE_SAMPLE_COUNTS[levelIDC];
    if (levelMaximumPictureSampleCount === undefined) {
        return implementationMaximum;
    }
    if (pictureSampleCount > levelMaximumPictureSampleCount) {
        throw new TypeError('The HEVC SPS dimensions exceed the declared level');
    }

    let levelMaximum: number;
    if (pictureSampleCount <= levelMaximumPictureSampleCount / 4) {
        levelMaximum = Math.min(
            4 * MAIN_PROFILE_BASE_DPB_PICTURE_COUNT,
            MAXIMUM_HEVC_DPB_PICTURE_COUNT
        );
    } else if (pictureSampleCount <= levelMaximumPictureSampleCount / 2) {
        levelMaximum = Math.min(
            2 * MAIN_PROFILE_BASE_DPB_PICTURE_COUNT,
            MAXIMUM_HEVC_DPB_PICTURE_COUNT
        );
    } else if (pictureSampleCount <= (3 * levelMaximumPictureSampleCount) / 4) {
        levelMaximum = Math.min(
            Math.floor((4 * MAIN_PROFILE_BASE_DPB_PICTURE_COUNT) / 3),
            MAXIMUM_HEVC_DPB_PICTURE_COUNT
        );
    } else {
        levelMaximum = MAIN_PROFILE_BASE_DPB_PICTURE_COUNT;
    }
    return Math.min(levelMaximum, implementationMaximum);
}

function parseSubLayerOrdering(
    reader: BoundedBitReader,
    maximumSubLayerIndex: number,
    maximumDPBPictureCount: number
): number {
    const subLayerOrderingInfoPresent = reader.readFlag(
        'sps_sub_layer_ordering_info_present_flag'
    );
    const firstOrderingLayer = subLayerOrderingInfoPresent ? 0 : maximumSubLayerIndex;
    let previousBufferingMinus1 = -1;
    let previousReorderPictureCount = -1;
    let declaredMaximumDPBPictureCount = 0;
    for (let subLayerIndex = firstOrderingLayer;
        subLayerIndex <= maximumSubLayerIndex;
        subLayerIndex += 1
    ) {
        const bufferingMinus1 = reader.readUnsignedExpGolomb(
            'sps_max_dec_pic_buffering_minus1',
            MAXIMUM_HEVC_DPB_PICTURE_COUNT - 1
        );
        const reorderPictureCount = reader.readUnsignedExpGolomb(
            'sps_max_num_reorder_pics',
            MAXIMUM_HEVC_DPB_PICTURE_COUNT - 1
        );
        reader.readUnsignedExpGolomb(
            'sps_max_latency_increase_plus1',
            MAXIMUM_UNSIGNED_EXP_GOLOMB_VALUE
        );
        const decodedPictureBufferSize = bufferingMinus1 + 1;
        if (decodedPictureBufferSize > maximumDPBPictureCount) {
            throw new TypeError(
                'The HEVC SPS decoded picture buffer exceeds its level and picture-size bound'
            );
        }
        if (reorderPictureCount > bufferingMinus1) {
            throw new TypeError('The HEVC SPS reorder count exceeds its decoded picture buffer');
        }
        if (
            previousBufferingMinus1 > bufferingMinus1
            || previousReorderPictureCount > reorderPictureCount
        ) {
            throw new TypeError('The HEVC SPS sub-layer ordering is not monotonic');
        }
        previousBufferingMinus1 = bufferingMinus1;
        previousReorderPictureCount = reorderPictureCount;
        declaredMaximumDPBPictureCount = Math.max(
            declaredMaximumDPBPictureCount,
            decodedPictureBufferSize
        );
    }
    return declaredMaximumDPBPictureCount;
}

function skipCodingStructure(reader: BoundedBitReader): void {
    reader.readUnsignedExpGolomb('log2_min_luma_coding_block_size_minus3', 3);
    reader.readUnsignedExpGolomb('log2_diff_max_min_luma_coding_block_size', 6);
    reader.readUnsignedExpGolomb('log2_min_luma_transform_block_size_minus2', 3);
    reader.readUnsignedExpGolomb('log2_diff_max_min_luma_transform_block_size', 3);
    reader.readUnsignedExpGolomb('max_transform_hierarchy_depth_inter', 5);
    reader.readUnsignedExpGolomb('max_transform_hierarchy_depth_intra', 5);

    if (reader.readFlag('scaling_list_enabled_flag')
        && reader.readFlag('sps_scaling_list_data_present_flag')
    ) {
        skipScalingListData(reader);
    }
    reader.skipBits(1, 'amp_enabled_flag');
    reader.skipBits(1, 'sample_adaptive_offset_enabled_flag');
    if (reader.readFlag('pcm_enabled_flag')) {
        reader.skipBits(8, 'pcm_sample_bit_depth');
        reader.readUnsignedExpGolomb('log2_min_pcm_luma_coding_block_size_minus3', 3);
        reader.readUnsignedExpGolomb('log2_diff_max_min_pcm_luma_coding_block_size', 6);
        reader.skipBits(1, 'pcm_loop_filter_disabled_flag');
    }
}

function skipReferencePictureSyntax(
    reader: BoundedBitReader,
    log2MaximumPictureOrderCountLSBMinus4: number
): void {
    const shortTermReferencePictureSetCount = reader.readUnsignedExpGolomb(
        'num_short_term_ref_pic_sets',
        MAXIMUM_HEVC_SHORT_TERM_REFERENCE_PICTURE_SET_COUNT
    );
    parseShortTermReferencePictureSets(reader, shortTermReferencePictureSetCount);
    if (!reader.readFlag('long_term_ref_pics_present_flag')) {
        return;
    }

    const longTermReferencePictureCount = reader.readUnsignedExpGolomb(
        'num_long_term_ref_pics_sps',
        MAXIMUM_HEVC_REFERENCE_PICTURE_COUNT
    );
    const pictureOrderCountBitCount = log2MaximumPictureOrderCountLSBMinus4 + 4;
    for (let pictureIndex = 0;
        pictureIndex < longTermReferencePictureCount;
        pictureIndex += 1
    ) {
        reader.skipBits(pictureOrderCountBitCount, 'lt_ref_pic_poc_lsb_sps');
        reader.skipBits(1, 'used_by_curr_pic_lt_sps_flag');
    }
}

type ParsedHEVCSPS = {
    configuration: HEVCSPSConfiguration
    RBSP: Uint8Array
    VUI: ParsedVUI
};

function parseHEVCSPSSyntax(nalUnit: Uint8Array): ParsedHEVCSPS {
    const RBSP = createRBSP(nalUnit);
    const reader = new BoundedBitReader(RBSP);
    reader.skipBits(4, 'sps_video_parameter_set_id');
    const maximumSubLayerIndex = reader.readBits(3, 'sps_max_sub_layers_minus1');
    if (maximumSubLayerIndex > 6) {
        throw new TypeError('The HEVC SPS has too many temporal sub-layers');
    }
    reader.skipBits(1, 'sps_temporal_id_nesting_flag');
    const profileTierLevel = parseProfileTierLevel(reader, maximumSubLayerIndex);
    if (profileTierLevel.profileIDC !== 1 && profileTierLevel.profileIDC !== 2) {
        throw new TypeError('The HEVC SPS profile is unsupported');
    }
    if (!profileTierLevel.progressiveSource || profileTierLevel.interlacedSource) {
        throw new TypeError('The HEVC SPS is not constrained to progressive pictures');
    }

    reader.readUnsignedExpGolomb('sps_seq_parameter_set_id', 15);
    const chromaFormat = reader.readUnsignedExpGolomb('chroma_format_idc', 3);
    if (chromaFormat !== 1) {
        throw new TypeError('The HEVC SPS chroma format is not 4:2:0');
    }
    const dimensions = parseSPSDimensions(reader);
    const bitDepthConfiguration = parseSPSBitDepth(reader);
    const maximumDPBPictureCount = parseSubLayerOrdering(
        reader,
        maximumSubLayerIndex,
        getMaximumDPBPictureCount(
            profileTierLevel.levelIDC,
            dimensions.codedWidth,
            dimensions.codedHeight
        )
    );
    skipCodingStructure(reader);
    skipReferencePictureSyntax(
        reader,
        bitDepthConfiguration.log2MaximumPictureOrderCountLSBMinus4
    );
    reader.skipBits(1, 'sps_temporal_mvp_enabled_flag');
    reader.skipBits(1, 'strong_intra_smoothing_enabled_flag');
    if (!reader.readFlag('vui_parameters_present_flag')) {
        throw new TypeError('The HEVC SPS has no VUI parameters');
    }
    const vui = parseVUI(reader);
    if (vui.fieldSequence) {
        throw new TypeError('The HEVC SPS describes an interlaced field sequence');
    }

    return {
        configuration: {
            bitDepth: bitDepthConfiguration.bitDepth,
            chromaFormat: 1,
            codedHeight: dimensions.codedHeight,
            codedWidth: dimensions.codedWidth,
            colorSpace: vui.colorSpace,
            displayHeight: dimensions.displayHeight,
            displayWidth: dimensions.displayWidth,
            levelIDC: profileTierLevel.levelIDC,
            maximumDPBPictureCount,
            profileIDC: profileTierLevel.profileIDC,
            progressive: true
        },
        RBSP,
        VUI: vui
    };
}

function writeBits(
    bytes: Uint8Array,
    bitOffset: number,
    bitCount: number,
    value: number
): void {
    for (let bitIndex = 0; bitIndex < bitCount; bitIndex += 1) {
        const destinationBitOffset = bitOffset + bitIndex;
        const byteOffset = Math.floor(destinationBitOffset / 8);
        const shift = 7 - (destinationBitOffset % 8);
        const bitValue = (value >> (bitCount - bitIndex - 1)) & 1;
        bytes[byteOffset] = (bytes[byteOffset] & ~(1 << shift)) | (bitValue << shift);
    }
}

function createNALUnitFromRBSP(nalUnit: Uint8Array, RBSP: Uint8Array): Uint8Array {
    const escapedBytes: number[] = [ nalUnit[0], nalUnit[1] ];
    let consecutiveZeroCount = 0;
    for (const byteValue of RBSP) {
        if (consecutiveZeroCount >= 2 && byteValue <= 3) {
            escapedBytes.push(3);
            consecutiveZeroCount = 0;
        }
        escapedBytes.push(byteValue);
        consecutiveZeroCount = byteValue === 0 ? consecutiveZeroCount + 1 : 0;
    }
    return new Uint8Array(escapedBytes);
}

/** Parses the bounded SPS fields required by the planar software decoder. */
export function parseHEVCSPS(nalUnit: Uint8Array): HEVCSPSConfiguration {
    return parseHEVCSPSSyntax(nalUnit).configuration;
}

/** Rewrites an existing VUI color description without changing coded video syntax. */
export function rewriteHEVCSPSColorDescriptionToBT709(
    nalUnit: Uint8Array,
    expectedHDRTransfer?: HEVCHDRTransfer
): Uint8Array {
    const parsedSPS = parseHEVCSPSSyntax(nalUnit);
    const offsets = parsedSPS.VUI.colorDescriptionOffsets;
    if (!offsets) {
        throw new TypeError('The HEVC SPS has no VUI color description to rewrite');
    }
    const colorSpace = parsedSPS.configuration.colorSpace;
    if (expectedHDRTransfer !== undefined && (
        colorSpace?.fullRange !== false
        || colorSpace.matrix !== 'bt2020-ncl'
        || colorSpace.primaries !== 'bt2020'
        || colorSpace.transfer !== expectedHDRTransfer
    )) {
        throw new TypeError(
            'The HEVC SPS does not match the expected limited-range BT.2020 HDR route'
        );
    }
    if (
        colorSpace?.fullRange === false
        && colorSpace.matrix === 'bt709'
        && colorSpace.primaries === 'bt709'
        && colorSpace.transfer === 'bt709'
    ) {
        return nalUnit.slice();
    }

    const rewrittenRBSP = parsedSPS.RBSP.slice();
    writeBits(rewrittenRBSP, offsets.fullRange, 1, 0);
    writeBits(rewrittenRBSP, offsets.primaries, 8, 1);
    writeBits(rewrittenRBSP, offsets.transfer, 8, 1);
    writeBits(rewrittenRBSP, offsets.matrix, 8, 1);
    return createNALUnitFromRBSP(nalUnit, rewrittenRBSP);
}
