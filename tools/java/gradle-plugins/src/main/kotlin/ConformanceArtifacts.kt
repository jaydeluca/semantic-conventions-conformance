/*
 * Copyright The OpenTelemetry Authors
 * SPDX-License-Identifier: Apache-2.0
 */

import java.nio.charset.StandardCharsets
import javax.inject.Inject
import org.gradle.api.DefaultTask
import org.gradle.api.GradleException
import org.gradle.api.artifacts.ConfigurationContainer
import org.gradle.api.artifacts.component.ModuleComponentIdentifier
import org.gradle.api.file.RegularFileProperty
import org.gradle.api.model.ObjectFactory
import org.gradle.api.provider.ListProperty
import org.gradle.api.tasks.CacheableTask
import org.gradle.api.tasks.Input
import org.gradle.api.tasks.OutputFile
import org.gradle.api.tasks.TaskAction

private const val INSTRUMENTED_LIBRARY = "instrumented_library"
private const val INSTRUMENTATION_LIBRARY = "instrumentation_library"
private const val RUNTIME_CLASSPATH = "runtimeClasspath"
private const val JAVA_AGENT = "javaAgent"

internal data class ConformanceArtifactSelector(
    val role: String,
    val group: String,
    val module: String,
    val configurations: List<String>,
) {
    val coordinate: String
        get() = "$group:$module"
}

internal data class ResolvedConformanceArtifact(
    val role: String,
    val coordinate: String,
    val version: String,
) {
    fun encoded(): String = listOf(role, coordinate, version).joinToString("\u0000")

    companion object {
        fun decode(value: String): ResolvedConformanceArtifact {
            val fields = value.split('\u0000')
            require(fields.size == 3) { "invalid encoded conformance artifact" }
            return ResolvedConformanceArtifact(fields[0], fields[1], fields[2])
        }
    }
}

abstract class ConformanceArtifactsExtension @Inject constructor(objects: ObjectFactory) {
    internal val selectors: ListProperty<ConformanceArtifactSelector> =
        objects.listProperty(ConformanceArtifactSelector::class.java).convention(emptyList())

    fun instrumentedLibrary(group: String, module: String) {
        add(INSTRUMENTED_LIBRARY, group, module, listOf(RUNTIME_CLASSPATH))
    }

    fun instrumentationLibrary(group: String, module: String) {
        add(
            INSTRUMENTATION_LIBRARY,
            group,
            module,
            listOf(RUNTIME_CLASSPATH, JAVA_AGENT),
        )
    }

    private fun add(
        role: String,
        group: String,
        module: String,
        configurations: List<String>,
    ) {
        require(group.isNotBlank()) { "artifact group must not be blank" }
        require(module.isNotBlank()) { "artifact module must not be blank" }
        require(':' !in group && ':' !in module) {
            "artifact group and module must be supplied separately"
        }
        selectors.add(ConformanceArtifactSelector(role, group, module, configurations))
    }
}

internal fun resolveConformanceArtifacts(
    projectPath: String,
    selectors: List<ConformanceArtifactSelector>,
    configurations: ConfigurationContainer,
): List<ResolvedConformanceArtifact> {
    val duplicate =
        selectors
            .groupBy { it.role to it.coordinate }
            .entries
            .firstOrNull { it.value.size > 1 }
    if (duplicate != null) {
        val (role, coordinate) = duplicate.key
        throw GradleException(
            "Project $projectPath declares more than one $role selector for $coordinate",
        )
    }

    return selectors
        .map { selector ->
            val versions =
                selector.configurations
                    .asSequence()
                    .flatMap { configuration ->
                        configurations
                            .getByName(configuration)
                            .incoming
                            .resolutionResult
                            .allComponents
                            .asSequence()
                    }
                    .mapNotNull { it.id as? ModuleComponentIdentifier }
                    .filter {
                        it.group == selector.group && it.module == selector.module
                    }.map { it.version }
                    .distinct()
                    .sorted()
                    .toList()

            if (versions.size != 1) {
                throw GradleException(
                    "Project $projectPath resolved ${versions.size} versions for " +
                        "${selector.role} ${selector.coordinate} from " +
                        "${selector.configurations.joinToString()}; expected exactly one",
                )
            }
            ResolvedConformanceArtifact(
                selector.role,
                selector.coordinate,
                versions.single(),
            )
        }.sortedWith(compareBy({ it.role }, { it.coordinate }, { it.version }))
}

@CacheableTask
abstract class WriteConformanceArtifacts : DefaultTask() {
    @get:Input
    abstract val artifacts: ListProperty<String>

    @get:OutputFile
    abstract val outputFile: RegularFileProperty

    @TaskAction
    fun write() {
        val resolved = artifacts.get().map(ResolvedConformanceArtifact::decode)
        if (resolved.isEmpty()) {
            // During the pilot, projects without declarations remain
            // unmigrated and must not publish an empty manifest.
            outputFile.get().asFile.delete()
            return
        }
        val json = buildString {
            append("{\n")
            append("  \"schema_version\": 1,\n")
            append("  \"generated_by\": \"otel-conformance-java prepare\",\n")
            append("  \"artifacts\": [\n")
            resolved.forEachIndexed { index, artifact ->
                append("    {\n")
                append("      \"role\": \"").append(jsonEscape(artifact.role)).append("\",\n")
                append("      \"ecosystem\": \"maven\",\n")
                append("      \"coordinate\": \"")
                    .append(jsonEscape(artifact.coordinate))
                    .append("\",\n")
                append("      \"version\": \"")
                    .append(jsonEscape(artifact.version))
                    .append("\"\n")
                append("    }")
                if (index != resolved.lastIndex) append(',')
                append('\n')
            }
            append("  ]\n")
            append("}\n")
        }

        val destination = outputFile.get().asFile.toPath()
        destination.parent.toFile().mkdirs()
        destination.toFile().writeText(json, StandardCharsets.UTF_8)
    }
}

private fun jsonEscape(value: String): String =
    buildString {
        value.forEach { character ->
            when (character) {
                '\\' -> append("\\\\")
                '"' -> append("\\\"")
                '\b' -> append("\\b")
                '\u000C' -> append("\\f")
                '\n' -> append("\\n")
                '\r' -> append("\\r")
                '\t' -> append("\\t")
                else -> {
                    if (character.code < 0x20) {
                        append("\\u%04x".format(character.code))
                    } else {
                        append(character)
                    }
                }
            }
        }
    }
