use std::alloc::{Layout, alloc_zeroed, dealloc};
use std::array;
use std::ffi::c_void;
use std::ptr::{null, null_mut};
use std::slice;

use dolby_vision::rpu::dovi_rpu::DoviRpu;
use dolby_vision::rpu::extension_metadata::blocks::ExtMetadataBlock;
use dolby_vision::rpu::rpu_data_mapping::{
    DoviMMRCurve, DoviMappingMethod, DoviPolynomialCurve, DoviReshapingCurve, RpuDataMapping,
};
use dolby_vision::rpu::rpu_data_nlq::DoviELType;
use dolby_vision::rpu::vdr_dm_data::VdrDmData;

const PARSER_SCHEMA_MAGIC: u32 = 0x5052_5644;
const PARSER_SCHEMA_VERSION: u32 = 1;
const PARSER_REVISION_PREFIX: u32 = 0x38AD_EC04;
const MAXIMUM_LINEAR_MEMORY_BYTE_LENGTH: u32 = 16 * 1_024 * 1_024;
const MAXIMUM_SHARED_BUFFER_BYTE_LENGTH: usize = 64 * 1_024;
const MAXIMUM_MAPPING_ID: usize = 15;
const MAXIMUM_PIVOT_COUNT: usize = 9;
const MAXIMUM_SEGMENT_COUNT: usize = 8;
const MAXIMUM_MMR_ORDER: usize = 3;
const MAXIMUM_MMR_COEFFICIENT_COUNT: usize = 7;
const MAXIMUM_MMR_VECTOR_COUNT: usize = 48;
const HEADER_U32_COUNT: usize = 48;
const HEADER_BYTE_LENGTH: usize = HEADER_U32_COUNT * size_of::<u32>();
const COLOR_FLOAT_COUNT: usize = 28;
const NLQ_FLOAT_COUNT: usize = 12;
const COMPONENT_HEADER_U32_COUNT: usize = 4;
const COMPONENT_PIVOT_FLOAT_COUNT: usize = 12;
const COMPONENT_SEGMENT_FLOAT_COUNT: usize = MAXIMUM_SEGMENT_COUNT * 4;
const COMPONENT_MMR_FLOAT_COUNT: usize = MAXIMUM_MMR_VECTOR_COUNT * 4;
const COMPONENT_BYTE_LENGTH: usize = (COMPONENT_HEADER_U32_COUNT
    + COMPONENT_PIVOT_FLOAT_COUNT
    + COMPONENT_SEGMENT_FLOAT_COUNT
    + COMPONENT_MMR_FLOAT_COUNT)
    * size_of::<u32>();
const OUTPUT_BYTE_LENGTH: usize = HEADER_BYTE_LENGTH
    + ((COLOR_FLOAT_COUNT + NLQ_FLOAT_COUNT) * size_of::<f32>())
    + (3 * COMPONENT_BYTE_LENGTH);
const LAST_ERROR_BYTE_LENGTH: usize = 512;
const MISSING_U32: u32 = u32::MAX;

const FLAG_USED_PREVIOUS_MAPPING: u32 = 1 << 0;
const FLAG_EXPLICIT_COLOR_METADATA: u32 = 1 << 1;
const FLAG_LEVEL1_METADATA: u32 = 1 << 2;
const FLAG_NLQ_PRESENT: u32 = 1 << 3;
const FLAG_NLQ_ACTIVE: u32 = 1 << 4;
const FLAG_MEL: u32 = 1 << 5;
const FLAG_FEL: u32 = 1 << 6;
const FLAG_SCENE_REFRESH: u32 = 1 << 7;
const FLAG_DEFAULT_COLOR_METADATA: u32 = 1 << 8;

const STATUS_INVALID_ARGUMENT: i32 = 1;
const STATUS_INPUT_TOO_LARGE: i32 = 2;
const STATUS_PARSE_FAILED: i32 = 3;
const STATUS_UNSUPPORTED_METADATA: i32 = 4;
const STATUS_MISSING_MAPPING_STATE: i32 = 5;
const STATUS_INVALID_MAPPING: i32 = 6;
const STATUS_INVALID_COLOR_METADATA: i32 = 7;

#[derive(Debug)]
struct ParserFailure {
    code: i32,
    message: String,
}

impl ParserFailure {
    fn new(code: i32, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

type ParserResult<T> = Result<T, ParserFailure>;

struct ParserContext {
    last_error: [u8; LAST_ERROR_BYTE_LENGTH],
    last_error_length: usize,
    mappings: [Option<RpuDataMapping>; MAXIMUM_MAPPING_ID + 1],
}

impl Default for ParserContext {
    fn default() -> Self {
        Self {
            last_error: [0; LAST_ERROR_BYTE_LENGTH],
            last_error_length: 0,
            mappings: array::from_fn(|_| None),
        }
    }
}

impl ParserContext {
    fn clear_error(&mut self) {
        self.last_error.fill(0);
        self.last_error_length = 0;
    }

    fn record_error(&mut self, failure: &ParserFailure) {
        self.last_error.fill(0);
        let bytes = failure.message.as_bytes();
        self.last_error_length = bytes.len().min(LAST_ERROR_BYTE_LENGTH);
        self.last_error[..self.last_error_length].copy_from_slice(&bytes[..self.last_error_length]);
    }

    fn reset(&mut self) {
        self.clear_error();
        self.mappings.fill(None);
    }

    fn parse(&mut self, input: &[u8], output: &mut [u8]) -> ParserResult<()> {
        let rpu = DoviRpu::parse_unspec62_nalu(input).map_err(|error| {
            ParserFailure::new(
                STATUS_PARSE_FAILED,
                format!("libdovi parse failed: {error}"),
            )
        })?;
        let mapping_resolution = self.resolve_mapping(&rpu)?;
        let packed_snapshot = PackedSnapshot::new(
            &rpu,
            &mapping_resolution.mapping,
            mapping_resolution.used_previous_mapping,
        )?;
        packed_snapshot.write(output);

        if let Some(mapping_id) = mapping_resolution.mapping_id_to_store {
            self.mappings[mapping_id] = Some(mapping_resolution.mapping);
        }
        self.clear_error();
        Ok(())
    }

    fn resolve_mapping(&self, rpu: &DoviRpu) -> ParserResult<MappingResolution> {
        if let Some(mapping) = &rpu.rpu_data_mapping {
            let mapping_id = require_mapping_id(mapping.vdr_rpu_id)?;
            return Ok(MappingResolution {
                mapping: mapping.clone(),
                mapping_id_to_store: Some(mapping_id),
                used_previous_mapping: false,
            });
        }

        if !rpu.header.use_prev_vdr_rpu_flag {
            return Err(ParserFailure::new(
                STATUS_MISSING_MAPPING_STATE,
                "RPU contains no mapping and does not reference prior state",
            ));
        }

        let requested_mapping_id = require_mapping_id(rpu.header.prev_vdr_rpu_id)?;
        let resolved_mapping = self.mappings[requested_mapping_id]
            .as_ref()
            .or(self.mappings[0].as_ref())
            .cloned()
            .ok_or_else(|| {
                ParserFailure::new(
                    STATUS_MISSING_MAPPING_STATE,
                    format!("RPU references unavailable prior mapping {requested_mapping_id}"),
                )
            })?;
        Ok(MappingResolution {
            mapping: resolved_mapping,
            mapping_id_to_store: None,
            used_previous_mapping: true,
        })
    }
}

struct MappingResolution {
    mapping: RpuDataMapping,
    mapping_id_to_store: Option<usize>,
    used_previous_mapping: bool,
}

#[derive(Clone, Copy, Default)]
struct PackedNLQData {
    deadzone_slope: f32,
    deadzone_threshold: f32,
    offset: f32,
    vdr_in_max: f32,
}

struct PackedComponent {
    flags: u32,
    mmr_vector_count: u32,
    num_pivots: u32,
    pivots: [f32; COMPONENT_PIVOT_FLOAT_COUNT],
    segment_data: [[f32; 4]; MAXIMUM_SEGMENT_COUNT],
    mmr_data: [[f32; 4]; MAXIMUM_MMR_VECTOR_COUNT],
}

impl Default for PackedComponent {
    fn default() -> Self {
        Self {
            flags: 0,
            mmr_vector_count: 0,
            num_pivots: 0,
            pivots: [0.0; COMPONENT_PIVOT_FLOAT_COUNT],
            segment_data: [[0.0; 4]; MAXIMUM_SEGMENT_COUNT],
            mmr_data: [[0.0; 4]; MAXIMUM_MMR_VECTOR_COUNT],
        }
    }
}

struct PackedSnapshot {
    color: VdrDmData,
    components: [PackedComponent; 3],
    explicit_color_metadata: bool,
    flags: u32,
    level1: Option<[u16; 3]>,
    nlq: [PackedNLQData; 3],
    rpu_crc32: u32,
    rpu_profile: u8,
    rpu_header: dolby_vision::rpu::rpu_data_header::RpuDataHeader,
    mapping_header: [u32; 5],
}

impl PackedSnapshot {
    fn new(
        rpu: &DoviRpu,
        mapping: &RpuDataMapping,
        used_previous_mapping: bool,
    ) -> ParserResult<Self> {
        if !matches!(rpu.dovi_profile, 5 | 7 | 8) {
            return Err(ParserFailure::new(
                STATUS_UNSUPPORTED_METADATA,
                format!("Dolby Vision profile {} is unsupported", rpu.dovi_profile),
            ));
        }
        if !rpu.header.vdr_seq_info_present_flag {
            return Err(ParserFailure::new(
                STATUS_UNSUPPORTED_METADATA,
                "RPU VDR sequence information is required",
            ));
        }
        validate_rpu_header(&rpu.header)?;
        if mapping.mapping_color_space != 0 || mapping.mapping_chroma_format_idc != 0 {
            return Err(ParserFailure::new(
                STATUS_UNSUPPORTED_METADATA,
                "Dolby Vision mapping color space or chroma format is unsupported",
            ));
        }

        let explicit_color_metadata = rpu.vdr_dm_data.is_some();
        let color = rpu
            .vdr_dm_data
            .clone()
            .unwrap_or_else(default_color_metadata);
        validate_color_metadata(&color)?;

        let components = [
            pack_component(&mapping.curves[0], &rpu.header)?,
            pack_component(&mapping.curves[1], &rpu.header)?,
            pack_component(&mapping.curves[2], &rpu.header)?,
        ];
        let (nlq, nlq_flags) = pack_nlq(mapping, &rpu.header)?;
        if rpu.dovi_profile == 5 && !rpu.header.disable_residual_flag {
            return Err(ParserFailure::new(
                STATUS_UNSUPPORTED_METADATA,
                "Profile 5 RPU unexpectedly enables an enhancement residual",
            ));
        }

        let level1 = match color.get_block(1) {
            Some(ExtMetadataBlock::Level1(level1)) => {
                Some([level1.min_pq, level1.max_pq, level1.avg_pq])
            }
            _ => None,
        };
        let mut flags = nlq_flags;
        if used_previous_mapping {
            flags |= FLAG_USED_PREVIOUS_MAPPING;
        }
        if explicit_color_metadata {
            flags |= FLAG_EXPLICIT_COLOR_METADATA;
        } else {
            flags |= FLAG_DEFAULT_COLOR_METADATA;
        }
        if level1.is_some() {
            flags |= FLAG_LEVEL1_METADATA;
        }
        if color.scene_refresh_flag != 0 {
            flags |= FLAG_SCENE_REFRESH;
        }

        Ok(Self {
            color,
            components,
            explicit_color_metadata,
            flags,
            level1,
            nlq,
            rpu_crc32: rpu.rpu_data_crc32,
            rpu_profile: rpu.dovi_profile,
            rpu_header: rpu.header.clone(),
            mapping_header: [
                require_u32(mapping.vdr_rpu_id, "VDR RPU mapping ID")?,
                require_u32(mapping.mapping_color_space, "mapping color space")?,
                require_u32(mapping.mapping_chroma_format_idc, "mapping chroma format")?,
                require_u32(mapping.num_x_partitions_minus1 + 1, "X partition count")?,
                require_u32(mapping.num_y_partitions_minus1 + 1, "Y partition count")?,
            ],
        })
    }

    fn write(&self, output: &mut [u8]) {
        output.fill(0);
        let mut writer = PackedWriter::new(output);
        let header = &self.rpu_header;
        let level1 =
            self.level1
                .unwrap_or([MISSING_U32 as u16, MISSING_U32 as u16, MISSING_U32 as u16]);
        let previous_mapping_id = if header.use_prev_vdr_rpu_flag {
            header.prev_vdr_rpu_id as u32
        } else {
            MISSING_U32
        };
        let nlq_method = if self.flags & FLAG_NLQ_PRESENT != 0 {
            0
        } else {
            MISSING_U32
        };

        writer.write_u32(PARSER_SCHEMA_MAGIC);
        writer.write_u32(PARSER_SCHEMA_VERSION);
        writer.write_u32(OUTPUT_BYTE_LENGTH as u32);
        writer.write_u32(self.flags);
        writer.write_u32(PARSER_REVISION_PREFIX);
        writer.write_u32(self.rpu_profile as u32);
        writer.write_u32(header.rpu_type as u32);
        writer.write_u32(header.rpu_format as u32);
        writer.write_u32(header.vdr_rpu_profile as u32);
        writer.write_u32(header.vdr_rpu_level as u32);
        writer.write_u32(header.coefficient_data_type as u32);
        writer.write_u32(header.coefficient_log2_denom as u32);
        writer.write_u32((header.bl_bit_depth_minus8 + 8) as u32);
        writer.write_u32((header.el_bit_depth_minus8 + 8) as u32);
        writer.write_u32((header.vdr_bit_depth_minus8 + 8) as u32);
        writer.write_u32(header.vdr_rpu_normalized_idc as u32);
        writer.write_u32(header.bl_video_full_range_flag as u32);
        writer.write_u32(header.chroma_resampling_explicit_filter_flag as u32);
        writer.write_u32(header.spatial_resampling_filter_flag as u32);
        writer.write_u32(header.el_spatial_resampling_filter_flag as u32);
        writer.write_u32(header.disable_residual_flag as u32);
        writer.write_u32(self.mapping_header[0]);
        writer.write_u32(previous_mapping_id);
        writer.write_u32(self.mapping_header[1]);
        writer.write_u32(self.mapping_header[2]);
        writer.write_u32(self.mapping_header[3]);
        writer.write_u32(self.mapping_header[4]);
        writer.write_u32(self.color.signal_eotf as u32);
        writer.write_u32(self.color.signal_eotf_param0 as u32);
        writer.write_u32(self.color.signal_eotf_param1 as u32);
        writer.write_u32(self.color.signal_eotf_param2);
        writer.write_u32(self.color.signal_bit_depth as u32);
        writer.write_u32(self.color.signal_color_space as u32);
        writer.write_u32(self.color.signal_chroma_format as u32);
        writer.write_u32(self.color.signal_full_range_flag as u32);
        writer.write_u32(self.color.source_min_pq as u32);
        writer.write_u32(self.color.source_max_pq as u32);
        writer.write_u32(self.color.source_diagonal as u32);
        writer.write_u32(if self.level1.is_some() {
            level1[0] as u32
        } else {
            MISSING_U32
        });
        writer.write_u32(if self.level1.is_some() {
            level1[1] as u32
        } else {
            MISSING_U32
        });
        writer.write_u32(if self.level1.is_some() {
            level1[2] as u32
        } else {
            MISSING_U32
        });
        writer.write_u32(self.color.scene_refresh_flag as u32);
        writer.write_u32(self.color.affected_dm_metadata_id as u32);
        writer.write_u32(self.color.current_dm_metadata_id as u32);
        writer.write_u32(nlq_method);
        writer.write_u32(self.rpu_crc32);
        writer.write_u32(header.ext_mapping_idc_0_4 as u32);
        writer.write_u32(header.ext_mapping_idc_5_7 as u32);
        debug_assert_eq!(writer.offset, HEADER_BYTE_LENGTH);

        let nonlinear_offsets = [
            self.color.ycc_to_rgb_offset0,
            self.color.ycc_to_rgb_offset1,
            self.color.ycc_to_rgb_offset2,
        ];
        for offset in nonlinear_offsets {
            writer.write_f32(offset as f32 / 268_435_456.0);
        }
        writer.write_f32(0.0);

        let nonlinear_matrix = [
            self.color.ycc_to_rgb_coef0,
            self.color.ycc_to_rgb_coef1,
            self.color.ycc_to_rgb_coef2,
            self.color.ycc_to_rgb_coef3,
            self.color.ycc_to_rgb_coef4,
            self.color.ycc_to_rgb_coef5,
            self.color.ycc_to_rgb_coef6,
            self.color.ycc_to_rgb_coef7,
            self.color.ycc_to_rgb_coef8,
        ];
        write_padded_matrix(&mut writer, &nonlinear_matrix, 8_192.0);
        let linear_matrix = [
            self.color.rgb_to_lms_coef0,
            self.color.rgb_to_lms_coef1,
            self.color.rgb_to_lms_coef2,
            self.color.rgb_to_lms_coef3,
            self.color.rgb_to_lms_coef4,
            self.color.rgb_to_lms_coef5,
            self.color.rgb_to_lms_coef6,
            self.color.rgb_to_lms_coef7,
            self.color.rgb_to_lms_coef8,
        ];
        write_padded_matrix(&mut writer, &linear_matrix, 16_384.0);

        for component in self.nlq {
            writer.write_f32(component.offset);
            writer.write_f32(component.deadzone_slope);
            writer.write_f32(component.deadzone_threshold);
            writer.write_f32(component.vdr_in_max);
        }
        for component in &self.components {
            component.write(&mut writer);
        }
        debug_assert_eq!(writer.offset, OUTPUT_BYTE_LENGTH);
        debug_assert_eq!(
            self.explicit_color_metadata,
            self.flags & FLAG_EXPLICIT_COLOR_METADATA != 0
        );
    }
}

impl PackedComponent {
    fn write(&self, writer: &mut PackedWriter<'_>) {
        writer.write_u32(self.num_pivots);
        writer.write_u32(self.mmr_vector_count);
        writer.write_u32(self.flags);
        writer.write_u32(0);
        for pivot in self.pivots {
            writer.write_f32(pivot);
        }
        for segment in self.segment_data {
            for value in segment {
                writer.write_f32(value);
            }
        }
        for vector in self.mmr_data {
            for value in vector {
                writer.write_f32(value);
            }
        }
    }
}

struct PackedWriter<'a> {
    data: &'a mut [u8],
    offset: usize,
}

impl<'a> PackedWriter<'a> {
    fn new(data: &'a mut [u8]) -> Self {
        Self { data, offset: 0 }
    }

    fn write_f32(&mut self, value: f32) {
        self.write_bytes(&value.to_le_bytes());
    }

    fn write_u32(&mut self, value: u32) {
        self.write_bytes(&value.to_le_bytes());
    }

    fn write_bytes(&mut self, bytes: &[u8]) {
        let end = self.offset + bytes.len();
        self.data[self.offset..end].copy_from_slice(bytes);
        self.offset = end;
    }
}

fn require_mapping_id(value: u64) -> ParserResult<usize> {
    let mapping_id = usize::try_from(value).map_err(|_| {
        ParserFailure::new(STATUS_INVALID_MAPPING, "RPU mapping ID does not fit usize")
    })?;
    if mapping_id > MAXIMUM_MAPPING_ID {
        return Err(ParserFailure::new(
            STATUS_INVALID_MAPPING,
            format!("RPU mapping ID {mapping_id} exceeds {MAXIMUM_MAPPING_ID}"),
        ));
    }
    Ok(mapping_id)
}

fn require_u32(value: u64, name: &str) -> ParserResult<u32> {
    u32::try_from(value).map_err(|_| {
        ParserFailure::new(
            STATUS_INVALID_MAPPING,
            format!("{name} does not fit the packed schema"),
        )
    })
}

fn validate_color_metadata(color: &VdrDmData) -> ParserResult<()> {
    if color.compressed {
        return Err(ParserFailure::new(
            STATUS_UNSUPPORTED_METADATA,
            "Compressed Dolby Vision display metadata is not supported",
        ));
    }
    if color.affected_dm_metadata_id != color.current_dm_metadata_id {
        return Err(ParserFailure::new(
            STATUS_INVALID_COLOR_METADATA,
            "Affected and current Dolby Vision metadata IDs differ",
        ));
    }
    if color.signal_bit_depth < 8 || color.signal_bit_depth > 16 {
        return Err(ParserFailure::new(
            STATUS_INVALID_COLOR_METADATA,
            "Dolby Vision signal bit depth is outside 8 through 16",
        ));
    }
    Ok(())
}

fn validate_rpu_header(
    header: &dolby_vision::rpu::rpu_data_header::RpuDataHeader,
) -> ParserResult<()> {
    let bit_depth_values = [
        header.bl_bit_depth_minus8,
        header.el_bit_depth_minus8,
        header.vdr_bit_depth_minus8,
    ];
    if bit_depth_values.iter().any(|value| *value > 8) {
        return Err(ParserFailure::new(
            STATUS_UNSUPPORTED_METADATA,
            "Dolby Vision bit depth is outside 8 through 16",
        ));
    }
    if header.coefficient_log2_denom > 32 {
        return Err(ParserFailure::new(
            STATUS_INVALID_MAPPING,
            "Coefficient denominator exceeds 32 bits",
        ));
    }
    Ok(())
}

// These defaults match the decoder state used by the pinned FFmpeg reference
// when an RPU omits explicit display metadata.
fn default_color_metadata() -> VdrDmData {
    VdrDmData {
        ycc_to_rgb_coef0: 9_575,
        ycc_to_rgb_coef1: 0,
        ycc_to_rgb_coef2: 14_742,
        ycc_to_rgb_coef3: 9_575,
        ycc_to_rgb_coef4: 1_754,
        ycc_to_rgb_coef5: 4_383,
        ycc_to_rgb_coef6: 9_575,
        ycc_to_rgb_coef7: 17_372,
        ycc_to_rgb_coef8: 0,
        ycc_to_rgb_offset0: 67_108_864,
        ycc_to_rgb_offset1: 536_870_912,
        ycc_to_rgb_offset2: 536_870_912,
        rgb_to_lms_coef0: 5_845,
        rgb_to_lms_coef1: 9_702,
        rgb_to_lms_coef2: 837,
        rgb_to_lms_coef3: 2_568,
        rgb_to_lms_coef4: 12_256,
        rgb_to_lms_coef5: 1_561,
        rgb_to_lms_coef6: 0,
        rgb_to_lms_coef7: 679,
        rgb_to_lms_coef8: 15_705,
        signal_eotf: 39_322,
        signal_eotf_param0: 15_867,
        signal_eotf_param1: 228,
        signal_eotf_param2: 1_383_604,
        signal_bit_depth: 14,
        signal_color_space: 0,
        signal_chroma_format: 0,
        signal_full_range_flag: 1,
        source_min_pq: 62,
        source_max_pq: 3_696,
        source_diagonal: 42,
        ..VdrDmData::default()
    }
}

fn write_padded_matrix(writer: &mut PackedWriter<'_>, matrix: &[i16; 9], scale: f32) {
    for row_index in 0..3 {
        for column_index in 0..3 {
            writer.write_f32(matrix[(row_index * 3) + column_index] as f32 / scale);
        }
        writer.write_f32(0.0);
    }
}

fn pack_component(
    curve: &DoviReshapingCurve,
    header: &dolby_vision::rpu::rpu_data_header::RpuDataHeader,
) -> ParserResult<PackedComponent> {
    let num_pivots = curve.pivots.len();
    if !(2..=MAXIMUM_PIVOT_COUNT).contains(&num_pivots)
        || curve.num_pivots_minus2 as usize + 2 != num_pivots
    {
        return Err(ParserFailure::new(
            STATUS_INVALID_MAPPING,
            "Dolby Vision reshaping pivot count is invalid",
        ));
    }
    let segment_count = num_pivots - 1;
    let bit_depth = u32::try_from(header.bl_bit_depth_minus8 + 8).map_err(|_| {
        ParserFailure::new(STATUS_INVALID_MAPPING, "Base-layer bit depth is invalid")
    })?;
    let pivot_denominator = (1_u32 << bit_depth) - 1;
    let mut packed = PackedComponent {
        num_pivots: num_pivots as u32,
        ..PackedComponent::default()
    };
    let mut cumulative_pivot = 0_u32;
    for (pivot_index, pivot_delta) in curve.pivots.iter().enumerate() {
        cumulative_pivot = cumulative_pivot
            .checked_add(*pivot_delta as u32)
            .ok_or_else(|| {
                ParserFailure::new(STATUS_INVALID_MAPPING, "Dolby Vision pivot overflowed")
            })?;
        if cumulative_pivot > pivot_denominator {
            return Err(ParserFailure::new(
                STATUS_INVALID_MAPPING,
                "Dolby Vision pivot exceeds the base-layer range",
            ));
        }
        packed.pivots[pivot_index] = cumulative_pivot as f32 / pivot_denominator as f32;
    }

    match curve.mapping_idc {
        DoviMappingMethod::Polynomial => {
            packed.flags = 1;
            pack_polynomial_segments(
                &mut packed,
                curve.polynomial.as_ref().ok_or_else(|| {
                    ParserFailure::new(
                        STATUS_INVALID_MAPPING,
                        "Polynomial reshape is missing its coefficients",
                    )
                })?,
                segment_count,
                header,
            )?;
        }
        DoviMappingMethod::MMR => {
            packed.flags = 2;
            pack_mmr_segments(
                &mut packed,
                curve.mmr.as_ref().ok_or_else(|| {
                    ParserFailure::new(
                        STATUS_INVALID_MAPPING,
                        "MMR reshape is missing its coefficients",
                    )
                })?,
                segment_count,
                header,
            )?;
        }
        DoviMappingMethod::Invalid => {
            return Err(ParserFailure::new(
                STATUS_INVALID_MAPPING,
                "Dolby Vision reshape uses an invalid mapping method",
            ));
        }
    }
    Ok(packed)
}

fn pack_polynomial_segments(
    packed: &mut PackedComponent,
    polynomial: &DoviPolynomialCurve,
    segment_count: usize,
    header: &dolby_vision::rpu::rpu_data_header::RpuDataHeader,
) -> ParserResult<()> {
    if polynomial.poly_order_minus1.len() != segment_count
        || polynomial.poly_coef.len() != segment_count
    {
        return Err(ParserFailure::new(
            STATUS_INVALID_MAPPING,
            "Polynomial reshape segment arrays have inconsistent lengths",
        ));
    }
    for segment_index in 0..segment_count {
        if polynomial
            .linear_interp_flag
            .get(segment_index)
            .copied()
            .unwrap_or(false)
        {
            return Err(ParserFailure::new(
                STATUS_UNSUPPORTED_METADATA,
                "Polynomial linear interpolation is unsupported",
            ));
        }
        let coefficient_count = polynomial.poly_order_minus1[segment_index] as usize + 2;
        if !(2..=3).contains(&coefficient_count)
            || polynomial.poly_coef[segment_index].len() != coefficient_count
        {
            return Err(ParserFailure::new(
                STATUS_INVALID_MAPPING,
                "Polynomial reshape coefficient count is invalid",
            ));
        }
        for coefficient_index in 0..coefficient_count {
            let integer = polynomial
                .poly_coef_int
                .get(segment_index)
                .and_then(|values| values.get(coefficient_index))
                .copied();
            packed.segment_data[segment_index][coefficient_index] = signed_coefficient(
                header,
                integer,
                polynomial.poly_coef[segment_index][coefficient_index],
            )?;
        }
    }
    Ok(())
}

fn pack_mmr_segments(
    packed: &mut PackedComponent,
    mmr: &DoviMMRCurve,
    segment_count: usize,
    header: &dolby_vision::rpu::rpu_data_header::RpuDataHeader,
) -> ParserResult<()> {
    if mmr.mmr_order_minus1.len() != segment_count
        || mmr.mmr_constant.len() != segment_count
        || mmr.mmr_coef.len() != segment_count
    {
        return Err(ParserFailure::new(
            STATUS_INVALID_MAPPING,
            "MMR reshape segment arrays have inconsistent lengths",
        ));
    }
    let mut mmr_vector_index = 0;
    for segment_index in 0..segment_count {
        let order = mmr.mmr_order_minus1[segment_index] as usize + 1;
        if !(1..=MAXIMUM_MMR_ORDER).contains(&order) || mmr.mmr_coef[segment_index].len() != order {
            return Err(ParserFailure::new(
                STATUS_INVALID_MAPPING,
                "MMR reshape order is invalid",
            ));
        }
        packed.segment_data[segment_index][0] = signed_coefficient(
            header,
            mmr.mmr_constant_int.get(segment_index).copied(),
            mmr.mmr_constant[segment_index],
        )?;
        packed.segment_data[segment_index][1] = mmr_vector_index as f32;
        packed.segment_data[segment_index][3] = order as f32;

        for order_index in 0..order {
            if mmr.mmr_coef[segment_index][order_index].len() != MAXIMUM_MMR_COEFFICIENT_COUNT
                || mmr_vector_index + 1 >= MAXIMUM_MMR_VECTOR_COUNT
            {
                return Err(ParserFailure::new(
                    STATUS_INVALID_MAPPING,
                    "MMR reshape coefficient array exceeds its packed bound",
                ));
            }
            let mut coefficients = [0.0_f32; MAXIMUM_MMR_COEFFICIENT_COUNT];
            for (coefficient_index, coefficient) in coefficients.iter_mut().enumerate() {
                let integer = mmr
                    .mmr_coef_int
                    .get(segment_index)
                    .and_then(|orders| orders.get(order_index))
                    .and_then(|values| values.get(coefficient_index))
                    .copied();
                *coefficient = signed_coefficient(
                    header,
                    integer,
                    mmr.mmr_coef[segment_index][order_index][coefficient_index],
                )?;
            }
            packed.mmr_data[mmr_vector_index] =
                [coefficients[0], coefficients[1], coefficients[2], 0.0];
            packed.mmr_data[mmr_vector_index + 1] = [
                coefficients[3],
                coefficients[4],
                coefficients[5],
                coefficients[6],
            ];
            mmr_vector_index += 2;
        }
    }
    packed.mmr_vector_count = mmr_vector_index as u32;
    Ok(())
}

fn pack_nlq(
    mapping: &RpuDataMapping,
    header: &dolby_vision::rpu::rpu_data_header::RpuDataHeader,
) -> ParserResult<([PackedNLQData; 3], u32)> {
    let Some(nlq) = &mapping.nlq else {
        if !header.disable_residual_flag {
            return Err(ParserFailure::new(
                STATUS_UNSUPPORTED_METADATA,
                "Enabled enhancement residual has no LINEAR_DZ metadata",
            ));
        }
        return Ok(([PackedNLQData::default(); 3], 0));
    };
    if mapping.nlq_method_idc.is_none() {
        return Err(ParserFailure::new(
            STATUS_INVALID_MAPPING,
            "NLQ data has no declared method",
        ));
    }

    let mut packed = [PackedNLQData::default(); 3];
    let el_bit_depth = u32::try_from(header.el_bit_depth_minus8 + 8).map_err(|_| {
        ParserFailure::new(STATUS_INVALID_MAPPING, "Enhancement bit depth is invalid")
    })?;
    let el_denominator = ((1_u32 << el_bit_depth) - 1) as f32;
    let mut trivial = true;
    for (component_index, packed_component) in packed.iter_mut().enumerate() {
        let vdr_in_max = unsigned_coefficient(
            header,
            nlq.vdr_in_max_int[component_index],
            nlq.vdr_in_max[component_index],
        )?;
        let slope = unsigned_coefficient(
            header,
            nlq.linear_deadzone_slope_int[component_index],
            nlq.linear_deadzone_slope[component_index],
        )?;
        let threshold = unsigned_coefficient(
            header,
            nlq.linear_deadzone_threshold_int[component_index],
            nlq.linear_deadzone_threshold[component_index],
        )?;
        trivial &= nlq.nlq_offset[component_index] == 0
            && vdr_in_max == 1.0
            && slope == 0.0
            && threshold == 0.0;
        *packed_component = PackedNLQData {
            deadzone_slope: el_denominator * slope,
            deadzone_threshold: threshold - (0.5 * slope),
            offset: nlq.nlq_offset[component_index] as f32 / el_denominator,
            vdr_in_max,
        };
    }

    let mut flags = FLAG_NLQ_PRESENT;
    match nlq.el_type() {
        DoviELType::MEL => flags |= FLAG_MEL,
        DoviELType::FEL => flags |= FLAG_FEL,
    }
    if !header.disable_residual_flag && !trivial {
        flags |= FLAG_NLQ_ACTIVE;
    }
    Ok((packed, flags))
}

fn signed_coefficient(
    header: &dolby_vision::rpu::rpu_data_header::RpuDataHeader,
    integer: Option<i64>,
    fractional: u64,
) -> ParserResult<f32> {
    let value = match header.coefficient_data_type {
        0 => {
            let integer = integer.ok_or_else(|| {
                ParserFailure::new(
                    STATUS_INVALID_MAPPING,
                    "Fixed-point coefficient is missing its integer part",
                )
            })?;
            integer as f64 + fractional as f64 / coefficient_scale(header)?
        }
        1 => float_coefficient(fractional)?,
        _ => {
            return Err(ParserFailure::new(
                STATUS_UNSUPPORTED_METADATA,
                "Dolby Vision coefficient data type is unsupported",
            ));
        }
    };
    finite_f32(value)
}

fn unsigned_coefficient(
    header: &dolby_vision::rpu::rpu_data_header::RpuDataHeader,
    integer: u64,
    fractional: u64,
) -> ParserResult<f32> {
    let value = match header.coefficient_data_type {
        0 => integer as f64 + fractional as f64 / coefficient_scale(header)?,
        1 => float_coefficient(fractional)?,
        _ => {
            return Err(ParserFailure::new(
                STATUS_UNSUPPORTED_METADATA,
                "Dolby Vision coefficient data type is unsupported",
            ));
        }
    };
    finite_f32(value)
}

fn coefficient_scale(
    header: &dolby_vision::rpu::rpu_data_header::RpuDataHeader,
) -> ParserResult<f64> {
    let denominator = u32::try_from(header.coefficient_log2_denom).map_err(|_| {
        ParserFailure::new(STATUS_INVALID_MAPPING, "Coefficient denominator is invalid")
    })?;
    if denominator > 32 {
        return Err(ParserFailure::new(
            STATUS_INVALID_MAPPING,
            "Coefficient denominator exceeds 32 bits",
        ));
    }
    Ok((1_u64 << denominator) as f64)
}

fn float_coefficient(bits: u64) -> ParserResult<f64> {
    let bits = u32::try_from(bits).map_err(|_| {
        ParserFailure::new(
            STATUS_INVALID_MAPPING,
            "Floating coefficient does not fit 32 bits",
        )
    })?;
    let value = f32::from_bits(bits);
    if !value.is_finite() {
        return Err(ParserFailure::new(
            STATUS_INVALID_MAPPING,
            "Floating coefficient is not finite",
        ));
    }
    Ok(value as f64)
}

fn finite_f32(value: f64) -> ParserResult<f32> {
    let packed = value as f32;
    if !packed.is_finite() {
        return Err(ParserFailure::new(
            STATUS_INVALID_MAPPING,
            "Coefficient exceeds finite float32 range",
        ));
    }
    Ok(packed)
}

fn parse_context<'a>(context: *mut c_void) -> Option<&'a mut ParserContext> {
    if context.is_null() {
        return None;
    }
    // SAFETY: The exported API creates and exclusively owns this pointer.
    Some(unsafe { &mut *(context.cast::<ParserContext>()) })
}

#[unsafe(no_mangle)]
pub extern "C" fn dovi_parser_schema_version() -> u32 {
    PARSER_SCHEMA_VERSION
}

#[unsafe(no_mangle)]
pub extern "C" fn dovi_parser_revision_prefix() -> u32 {
    PARSER_REVISION_PREFIX
}

#[unsafe(no_mangle)]
pub extern "C" fn dovi_parser_output_byte_length() -> u32 {
    OUTPUT_BYTE_LENGTH as u32
}

#[unsafe(no_mangle)]
pub extern "C" fn dovi_parser_maximum_buffer_byte_length() -> u32 {
    MAXIMUM_SHARED_BUFFER_BYTE_LENGTH as u32
}

#[unsafe(no_mangle)]
pub extern "C" fn dovi_parser_maximum_memory_byte_length() -> u32 {
    MAXIMUM_LINEAR_MEMORY_BYTE_LENGTH
}

#[unsafe(no_mangle)]
pub extern "C" fn dovi_parser_create() -> *mut c_void {
    Box::into_raw(Box::new(ParserContext::default())).cast::<c_void>()
}

#[unsafe(no_mangle)]
/// Destroys one context returned by `dovi_parser_create`.
///
/// # Safety
/// The pointer must be live and must not be used or destroyed again.
pub unsafe extern "C" fn dovi_parser_destroy(context: *mut c_void) {
    if context.is_null() {
        return;
    }
    // SAFETY: The caller relinquishes the pointer returned by create exactly once.
    unsafe {
        drop(Box::from_raw(context.cast::<ParserContext>()));
    }
}

#[unsafe(no_mangle)]
/// Clears the mapping state of one live parser context.
///
/// # Safety
/// The pointer must identify a live context returned by `dovi_parser_create`.
pub unsafe extern "C" fn dovi_parser_reset(context: *mut c_void) -> i32 {
    let Some(context) = parse_context(context) else {
        return STATUS_INVALID_ARGUMENT;
    };
    context.reset();
    0
}

#[unsafe(no_mangle)]
pub extern "C" fn dovi_parser_allocate(byte_length: u32) -> *mut u8 {
    let byte_length = byte_length as usize;
    if byte_length == 0 || byte_length > MAXIMUM_SHARED_BUFFER_BYTE_LENGTH {
        return null_mut();
    }
    let Ok(layout) = Layout::array::<u8>(byte_length) else {
        return null_mut();
    };
    // SAFETY: The matching exported deallocator receives the same layout.
    unsafe { alloc_zeroed(layout) }
}

#[unsafe(no_mangle)]
/// Releases one buffer returned by `dovi_parser_allocate`.
///
/// # Safety
/// The pointer and byte length must exactly match one live allocation.
pub unsafe extern "C" fn dovi_parser_deallocate(pointer: *mut u8, byte_length: u32) {
    let byte_length = byte_length as usize;
    if pointer.is_null() || byte_length == 0 || byte_length > MAXIMUM_SHARED_BUFFER_BYTE_LENGTH {
        return;
    }
    let Ok(layout) = Layout::array::<u8>(byte_length) else {
        return;
    };
    // SAFETY: The TypeScript wrapper preserves the original allocation length.
    unsafe {
        dealloc(pointer, layout);
    }
}

#[unsafe(no_mangle)]
/// Parses one RPU into the fixed schema output buffer.
///
/// # Safety
/// The context and both buffers must be live, non-overlapping allocations from
/// this module with at least the supplied lengths.
pub unsafe extern "C" fn dovi_parser_parse(
    context_pointer: *mut c_void,
    input_pointer: *const u8,
    input_byte_length: u32,
    output_pointer: *mut u8,
    output_byte_length: u32,
) -> i32 {
    let Some(context) = parse_context(context_pointer) else {
        return STATUS_INVALID_ARGUMENT;
    };
    if input_pointer.is_null() || output_pointer.is_null() {
        let failure = ParserFailure::new(STATUS_INVALID_ARGUMENT, "Parser buffer is null");
        context.record_error(&failure);
        return failure.code;
    }
    let input_byte_length = input_byte_length as usize;
    if input_byte_length == 0 || input_byte_length > MAXIMUM_SHARED_BUFFER_BYTE_LENGTH {
        let failure = ParserFailure::new(
            STATUS_INPUT_TOO_LARGE,
            "RPU input length is zero or exceeds 64 KiB",
        );
        context.record_error(&failure);
        return failure.code;
    }
    if output_byte_length as usize != OUTPUT_BYTE_LENGTH {
        let failure = ParserFailure::new(
            STATUS_INVALID_ARGUMENT,
            "Parser output length does not match schema version 1",
        );
        context.record_error(&failure);
        return failure.code;
    }

    // SAFETY: The caller allocated both bounded regions from this module.
    let input = unsafe { slice::from_raw_parts(input_pointer, input_byte_length) };
    // SAFETY: The exact fixed output length was checked above.
    let output = unsafe { slice::from_raw_parts_mut(output_pointer, OUTPUT_BYTE_LENGTH) };
    match context.parse(input, output) {
        Ok(()) => 0,
        Err(failure) => {
            context.record_error(&failure);
            failure.code
        }
    }
}

#[unsafe(no_mangle)]
/// Returns a borrowed diagnostic pointer owned by a live parser context.
///
/// # Safety
/// The context pointer must remain live until the diagnostic is copied.
pub unsafe extern "C" fn dovi_parser_last_error_pointer(context: *const c_void) -> *const u8 {
    if context.is_null() {
        return null();
    }
    // SAFETY: The pointer remains owned by the live parser context.
    let context = unsafe { &*(context.cast::<ParserContext>()) };
    context.last_error.as_ptr()
}

#[unsafe(no_mangle)]
/// Returns the current borrowed diagnostic length.
///
/// # Safety
/// The context pointer must identify a live parser context.
pub unsafe extern "C" fn dovi_parser_last_error_byte_length(context: *const c_void) -> u32 {
    if context.is_null() {
        return 0;
    }
    // SAFETY: The pointer remains owned by the live parser context.
    let context = unsafe { &*(context.cast::<ParserContext>()) };
    context.last_error_length as u32
}

#[cfg(test)]
mod tests {
    use super::*;

    fn prior_mapping_rpu(mapping_id: u64) -> DoviRpu {
        let mut rpu = DoviRpu::default();
        rpu.header.use_prev_vdr_rpu_flag = true;
        rpu.header.prev_vdr_rpu_id = mapping_id;
        rpu
    }

    #[test]
    fn explicit_mapping_is_returned_for_storage() {
        let context = ParserContext::default();
        let mapping = RpuDataMapping {
            vdr_rpu_id: 3,
            ..RpuDataMapping::default()
        };
        let mut rpu = DoviRpu::default();
        rpu.rpu_data_mapping = Some(mapping);

        let resolution = context.resolve_mapping(&rpu).unwrap();

        assert_eq!(resolution.mapping.vdr_rpu_id, 3);
        assert_eq!(resolution.mapping_id_to_store, Some(3));
        assert!(!resolution.used_previous_mapping);
    }

    #[test]
    fn requested_and_default_prior_mappings_match_ffmpeg_state_semantics() {
        let mut context = ParserContext::default();
        context.mappings[0] = Some(RpuDataMapping {
            vdr_rpu_id: 0,
            ..RpuDataMapping::default()
        });
        context.mappings[3] = Some(RpuDataMapping {
            vdr_rpu_id: 3,
            ..RpuDataMapping::default()
        });

        let exact = context.resolve_mapping(&prior_mapping_rpu(3)).unwrap();
        assert_eq!(exact.mapping.vdr_rpu_id, 3);
        assert!(exact.used_previous_mapping);
        assert_eq!(exact.mapping_id_to_store, None);

        let fallback = context.resolve_mapping(&prior_mapping_rpu(7)).unwrap();
        assert_eq!(fallback.mapping.vdr_rpu_id, 0);
        assert!(fallback.used_previous_mapping);
    }

    #[test]
    fn reset_discards_all_prior_mapping_state() {
        let mut context = ParserContext::default();
        context.mappings[0] = Some(RpuDataMapping::default());
        context.reset();

        let failure = context
            .resolve_mapping(&prior_mapping_rpu(0))
            .err()
            .unwrap();

        assert_eq!(failure.code, STATUS_MISSING_MAPPING_STATE);
        assert!(failure.message.contains("unavailable prior mapping 0"));
    }
}
