// General Layout Components
export { Container, type ContainerProps } from "./container";
export { Heading, type HeadingProps } from "./heading";

// General Layout Registrations & Registry
export {
  CONTAINER_BLOCK_RELEASE,
  HEADING_BLOCK_RELEASE,
  LAYOUT_BLOCK_RELEASES,
  LAYOUT_COMPONENT_REGISTRATIONS,
  createLayoutComponentRegistry,
} from "./registrations";
