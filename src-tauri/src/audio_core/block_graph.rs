use super::DspNode;

pub trait StemSource: Send {
    fn render_add(&mut self, output: &mut [f32], frames: usize, channels: usize);
}

pub struct SineStem {
    phase: f32,
    phase_step: f32,
    gain: f32,
}

impl SineStem {
    pub fn new(frequency_hz: f32, gain: f32, sample_rate: u32) -> Self {
        Self {
            phase: 0.0,
            phase_step: std::f32::consts::TAU * frequency_hz / sample_rate.max(1) as f32,
            gain,
        }
    }
}

impl StemSource for SineStem {
    fn render_add(&mut self, output: &mut [f32], frames: usize, channels: usize) {
        for frame in 0..frames {
            let sample = self.phase.sin() * self.gain;
            self.phase += self.phase_step;
            if self.phase >= std::f32::consts::TAU {
                self.phase -= std::f32::consts::TAU;
            }
            for channel in 0..channels {
                output[frame * channels + channel] += sample;
            }
        }
    }
}

pub struct GainNode {
    gain: f32,
}

impl GainNode {
    pub fn new(gain: f32) -> Self {
        Self { gain }
    }
}

impl DspNode for GainNode {
    fn process(&mut self, interleaved: &mut [f32], _channels: usize) {
        for sample in interleaved {
            *sample *= self.gain;
        }
    }
}

pub struct SoftClipNode {
    threshold: f32,
}

impl SoftClipNode {
    pub fn new(threshold: f32) -> Self {
        Self {
            threshold: threshold.clamp(0.01, 0.99),
        }
    }
}

impl DspNode for SoftClipNode {
    fn process(&mut self, interleaved: &mut [f32], _channels: usize) {
        for sample in interleaved {
            let magnitude = sample.abs();
            if magnitude > self.threshold {
                let over = (magnitude - self.threshold) / (1.0 - self.threshold);
                *sample = sample.signum() * (self.threshold + (1.0 - self.threshold) * over.tanh());
            }
        }
    }
}

pub struct BlockGraph {
    stems: Vec<Box<dyn StemSource>>,
    nodes: Vec<Box<dyn DspNode>>,
}

impl BlockGraph {
    pub fn new() -> Self {
        Self {
            stems: Vec::new(),
            nodes: Vec::new(),
        }
    }
    pub fn add_stem(&mut self, stem: impl StemSource + 'static) {
        self.stems.push(Box::new(stem));
    }
    pub fn add_node(&mut self, node: impl DspNode + 'static) {
        self.nodes.push(Box::new(node));
    }

    pub fn process(&mut self, output: &mut [f32], channels: usize) {
        let channels = channels.max(1);
        let frames = output.len() / channels;
        output.fill(0.0);
        for stem in &mut self.stems {
            stem.render_add(output, frames, channels);
        }
        for node in &mut self.nodes {
            node.process(output, channels);
        }
    }
}

impl Default for BlockGraph {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn block_graph_renders_multiple_stems_without_allocation_contract_changes() {
        let mut graph = BlockGraph::new();
        graph.add_stem(SineStem::new(220.0, 0.25, 48_000));
        graph.add_stem(SineStem::new(440.0, 0.25, 48_000));
        graph.add_node(SoftClipNode::new(0.8));
        let mut output = vec![0.0; 256 * 2];
        graph.process(&mut output, 2);
        assert!(output.iter().any(|sample| sample.abs() > 0.0));
        assert!(output.iter().all(|sample| sample.abs() <= 1.0));
    }

    #[test]
    fn gain_node_is_channel_agnostic() {
        let mut node = GainNode::new(0.5);
        let mut block = [1.0, -1.0, 0.5, -0.5];
        node.process(&mut block, 2);
        assert_eq!(block, [0.5, -0.5, 0.25, -0.25]);
    }
}
